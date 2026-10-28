import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  BUILDER_AGENT,
  DEFAULT_PERMISSION_MODE,
  enabledProvider,
  FolderBusyError,
  pathsOverlap,
  isSafeBranchName,
  isSafeRelativePath,
  isSafeRepoName,
  PAUSE_REASONS,
  errorMessage,
  QUESTION_TIMEOUT_MS,
  sessionToken,
  ValidationError,
  type Effort,
  effortFor,
  type PauseReason,
  type Repo,
  type Project,
  type RequestSource,
  type Session,
  type Store,
  type Worktree,
} from '@loop-engineering/core';
import type { AgentCli, LaunchSpec } from './agent-cli.js';
import {
  DEFAULT_MCP_TOKEN_ENV,
  OPENSOURCE_SEARCH_SKILL,
  PASSTHROUGH_ENV,
  SKILL_DIR,
  SKILL_FILE,
  writeSessionConfig,
} from './agent-config.js';
import { buildContinuationPrompt, type RepoState } from './continuation.js';
import type { Fs } from './drivers/fs.js';
import type { GitDriver } from './drivers/git.js';
import type { TmuxDriver, TmuxWindow } from './drivers/tmux.js';
import { sessionInstructions } from './instructions.js';
import { renderLaunchScript, shellQuote } from './launch.js';
import { sanitizeLine } from './sanitize.js';
import { detectTrustPrompt, TRUST_TAIL_LINES } from './trust-prompt.js';
import { DEFAULT_TAIL_LINES, detectUsageLimit, USAGE_LIMIT_PATTERNS } from './usage-limit.js';

export const DEFAULT_TMUX_SESSION = 'loop';
/** ask_human blocks for up to 15 minutes; the MCP tool timeout must outlast it. */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = QUESTION_TIMEOUT_MS + 5 * 60 * 1000;

export interface RunnerConfig {
  /** Folder holding every session's worktrees (WORKTREES_ROOT). Absolute. */
  worktreesRoot: string;
  /** Base URL of the always-on server (SERVER_URL); ask_human lives at `${serverUrl}/mcp`. */
  serverUrl: string;
  /** Per-session MCP/OpenCode configs and launch scripts. Default `${worktreesRoot}/.loop-runner`. */
  stateDir?: string;
  /** tmux session that holds one window per agent session. Default "loop". */
  tmuxSession?: string;
  /** Env var carrying the ask_human bearer token. Default MCP_TOKEN (what apps/server checks). */
  mcpTokenEnv?: string;
  /** Environment the token and optional API keys are read from. Default process.env. */
  env?: Record<string, string | undefined>;
  /** MCP_TOOL_TIMEOUT given to Claude, in ms. Default 20 minutes. */
  mcpToolTimeoutMs?: number;
  /** Where Claude saves conversations (`<dir>/<encoded cwd>/<id>.jsonl`). Default `$CLAUDE_CONFIG_DIR/projects` or ~/.claude/projects. */
  claudeProjectsDir?: string;
  /**
   * What a Claude builder does at its usage limit: 'opencode' relaunches it on the free fallback model
   * (default); 'wait' keeps it paused (usage_limit) until the monitor resumes it on Claude.
   */
  onClaudeLimit?: 'opencode' | 'wait';
  /** The Planner's current instructions, read at every launch; without it agents build without planning first. */
  planner?: () => string;
}

export interface RunnerDeps {
  store: Store;
  tmux: TmuxDriver;
  git: GitDriver;
  fs: Fs;
  agentCli: AgentCli;
  /** Injectable for deterministic tests. */
  ids?: { uuid(): string; suffix(): string };
  /** Warnings (e.g. a skipped file the repo tracks). Default console.warn. */
  log?: (message: string) => void;
  /** Milliseconds, for the relaunch rate limit. Default Date.now. */
  now?: () => number;
}

/** What to work on: new text, or a request the router already recorded. */
export type StartRequest =
  { text: string; source?: RequestSource; title?: string } | { requestId: number; title?: string };

export interface StartOptions {
  /** Default: Settings.sessionModel (the strongest model). */
  model?: string;
  effort?: Effort;
}

/** Least time between two relaunches of one session. */
const RELAUNCH_MIN_GAP_MS = 60_000;

export interface ResumeOptions {
  /** Only resume a session paused for this reason (an automatic resume never undoes a manual pause). */
  ifReason?: PauseReason;
  /** Why it resumes, for the agent's continuation prompt. Default: the pause reason. */
  reason?: string;
  /**
   * OpenCode: start a new conversation (with the full state) instead of --continue. Needed to change
   * its model: a continued OpenCode conversation keeps the model it was started with.
   */
  fresh?: boolean;
  /** Also hand the agent a file: written to `.loop/<name>` before the launch, `sentence` added to its first prompt. */
  deliver?: { name: string; content: string; sentence: string };
  /** Launch on the session's default model and effort, ignoring the builder's pick and the rigor level's effort. */
  defaults?: boolean;
}

export interface EndOptions {
  /** Remove worktrees even with uncommitted changes (they are lost). */
  force?: boolean;
}

export interface UsageCheckOptions {
  patterns?: readonly RegExp[];
  tailLines?: number;
}

function slug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return s || 'session';
}

/** Strictly inside `root` once both are resolved (`root` itself does not count). */
function isInside(root: string, path: string): boolean {
  const r = resolve(root);
  return resolve(path).startsWith(r.endsWith(sep) ? r : r + sep);
}

function assertInside(root: string, path: string, what: string): void {
  if (!isInside(root, path)) throw new ValidationError(`${what} ${path} is outside ${root}`);
}

/** Single-repo sessions run in the worktree; multi-repo ones in the folder holding all worktrees. */
function agentCwd(worktrees: Worktree[]): string {
  const [first] = worktrees;
  if (!first) throw new ValidationError('session has no worktrees');
  return worktrees.length === 1 ? first.path : dirname(first.path);
}

const windowName = (sessionId: number) => `s${sessionId}`;

/** Folder in the agent's working folder where the runner puts files for the agent (git-excluded). */
export const LOOP_DIR = '.loop';

export class SessionRunner {
  private readonly worktreesRoot: string;
  private readonly serverUrl: string;
  private readonly stateDir: string;
  private readonly tmuxSession: string;
  private readonly tokenEnv: string;
  private readonly env: Record<string, string | undefined>;
  private readonly mcpToolTimeoutMs: number;
  private readonly ids: { uuid(): string; suffix(): string };
  private readonly log: (message: string) => void;
  private readonly claudeProjectsDir: string;
  private readonly onClaudeLimit: 'opencode' | 'wait';
  private readonly planner: (() => string) | undefined;
  /** Per-session promise chains: start, pause, resume, fallback and reconcile never interleave. */
  private readonly locks = new Map<number, Promise<unknown>>();
  /** What each Claude builder was last launched with, to tell whether a relaunch would change anything. */
  private readonly launched = new Map<number, { model: string; effort: Effort | null }>();
  private readonly relaunchedAt = new Map<number, number>();
  private readonly now: () => number;

  constructor(
    private readonly deps: RunnerDeps,
    config: RunnerConfig,
  ) {
    this.worktreesRoot = resolve(config.worktreesRoot);
    this.stateDir = resolve(config.stateDir ?? join(config.worktreesRoot, '.loop-runner'));
    for (const [name, dir] of [
      ['worktreesRoot', config.worktreesRoot],
      ['stateDir', config.stateDir ?? config.worktreesRoot],
    ] as const) {
      // "#" is special in tmux formats; the paths reach tmux as -c and in the command.
      if (!isAbsolute(dir) || dir.includes('#'))
        throw new ValidationError(`${name} must be an absolute path without "#"`);
    }
    this.serverUrl = config.serverUrl;
    this.tmuxSession = config.tmuxSession ?? DEFAULT_TMUX_SESSION;
    this.tokenEnv = config.mcpTokenEnv ?? DEFAULT_MCP_TOKEN_ENV;
    this.env = config.env ?? process.env;
    this.mcpToolTimeoutMs = config.mcpToolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
    this.ids = deps.ids ?? { uuid: randomUUID, suffix: () => randomBytes(3).toString('hex') };
    this.log = deps.log ?? ((m) => console.warn(`[runner] ${m}`));
    this.now = deps.now ?? Date.now;
    this.claudeProjectsDir =
      config.claudeProjectsDir ?? join(this.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
    this.onClaudeLimit = config.onClaudeLimit ?? 'opencode';
    this.planner = config.planner;
  }

  /** Folders the runner owns (it creates and removes things there); no project folder may overlap them. */
  protectedRoots(): string[] {
    return [this.worktreesRoot, this.stateDir];
  }

  /**
   * Git project: creates a branch and a worktree per repo, copies env files, writes the agent config
   * and launches Claude in a tmux window. Folder project: launches Claude directly in the project
   * folder (no branch, worktree or env files), and only when no other session of the project is open
   * (FolderBusyError otherwise). Everything that can be checked is checked before anything is
   * created; on a later failure, whatever was created is removed and the session is ended.
   */
  async startSession(projectId: number, request: StartRequest, options: StartOptions = {}): Promise<Session> {
    const { store, git, fs } = this.deps;
    const project = store.projects.require(projectId);
    await this.checkProject(project);
    this.requireToken();
    for (const file of project.envFiles) {
      if (!(await fs.exists(file.source))) {
        throw new ValidationError(`env file ${file.source} (repo ${file.repo}) does not exist`);
      }
    }
    let text: string;
    if ('requestId' in request) {
      const recorded = store.requests.require(request.requestId);
      if (recorded.projectId !== projectId) {
        throw new ValidationError(`request ${recorded.id} belongs to project ${recorded.projectId}`);
      }
      text = recorded.text;
    } else {
      if (request.text.trim() === '') throw new ValidationError('request text must not be empty');
      text = request.text;
    }

    const title = (request.title ?? text.trim().split('\n')[0] ?? '').slice(0, 80) || 'session';
    if (project.kind === 'folder') {
      // No await between this check and create: two starts in this process cannot both pass it.
      const [open] = store.sessions.list({ projectId, status: ['active', 'paused'] });
      if (open) throw new FolderBusyError(projectId, open.id);
      const session = store.sessions.create({
        projectId,
        title,
        ...this.newAgent(options.model),
        branch: '',
        effort: options.effort ?? null,
      });
      return this.withLock(session.id, () => this.provision(project, session, null, text, request));
    }
    const leaf = `${slug(title)}-${this.ids.suffix()}`;
    const branch = `loop/${leaf}`;
    if (!isSafeBranchName(branch)) throw new ValidationError(`generated branch name ${branch} is invalid`);
    const sessionDir = join(this.worktreesRoot, slug(project.name), leaf);
    assertInside(this.worktreesRoot, sessionDir, 'session folder');
    for (const repo of project.repos) {
      if (await git.branchExists(repo.path, branch)) {
        throw new ValidationError(`branch ${branch} already exists in ${repo.name}`);
      }
    }

    // No await between create and taking the lock, so no other operation can see the half-made session.
    const session = store.sessions.create({
      projectId,
      title,
      ...this.newAgent(options.model),
      branch,
      effort: options.effort ?? null,
    });
    return this.withLock(session.id, () => this.provision(project, session, sessionDir, text, request));
  }

  /**
   * Stops the agent (its conversation stays resumable) and marks the session paused. Pausing a
   * session that is already paused keeps its original reason, so an automatic resume for that
   * reason still applies.
   */
  pause(sessionId: number, reason: PauseReason): Promise<Session> {
    if (!PAUSE_REASONS.includes(reason)) {
      return Promise.reject(new ValidationError(`a pause needs a reason (${PAUSE_REASONS.join(', ')})`));
    }
    return this.withLock(sessionId, async () => {
      const s = this.deps.store.sessions.require(sessionId);
      if (s.status === 'ended') throw new ValidationError(`session ${sessionId} has ended`);
      if (s.status === 'paused') return s;
      await this.killOwnWindow(s);
      return this.deps.store.sessions.update(sessionId, {
        status: 'paused',
        pauseReason: reason,
        tmuxTarget: null,
      });
    });
  }

  /**
   * Relaunches the agent on the session's current provider, continuing its conversation. Works on a
   * paused session and on an "active" one whose agent is gone. With `ifReason`, only a session
   * paused for that reason is resumed (an automatic resume never undoes a manual pause).
   */
  resume(sessionId: number, options: ResumeOptions = {}): Promise<Session> {
    return this.withLock(sessionId, () => this.resumeNow(sessionId, options));
  }

  /** resume() without taking the session's lock: for callers that already hold it. */
  private async resumeNow(sessionId: number, options: ResumeOptions): Promise<Session> {
    const { store } = this.deps;
    const s = store.sessions.require(sessionId);
    if (s.status === 'ended') throw new ValidationError(`session ${sessionId} has ended`);
    if (s.status === 'active' && (await this.isAlive(s))) return s;
    if (s.status === 'paused' && options.ifReason && s.pauseReason !== options.ifReason) return s;
    await this.killOwnWindow(s); // a dead pane kept by remain-on-exit
    const project = store.projects.require(s.projectId);
    const cwd = await this.sessionCwd(s, project);
    const why = options.reason ?? `the session was paused (${s.pauseReason ?? 'agent gone'})`;
    // The session's CLI was switched off since it started: move it to the one that is on, with a
    // fresh conversation that gets the full state (the old one cannot be continued across CLIs).
    const settings = store.settings.get();
    const provider = enabledProvider(settings, s.provider);
    const switched = provider !== s.provider;
    const model = !switched
      ? s.model
      : provider === 'claude'
        ? settings.sessionModel
        : settings.fallbackModel;
    // The builder's own model (dashboard or Planner) counts on Claude only; OpenCode has its chain.
    // It is not stored as the session's model, which stays the default "Use the default" goes back to.
    const launchModel =
      (provider === 'claude' && !options.defaults ? s.models[BUILDER_AGENT]?.model : undefined) ?? model;
    if (switched) {
      store.history.add({
        projectId: s.projectId,
        sessionId: s.id,
        kind: 'decision',
        text: `${s.provider} is switched off, so session ${s.id} resumed on ${provider}/${model} (from ${s.provider}/${s.model}).`,
      });
    }
    let agentSessionId = switched ? null : s.agentSessionId;
    let resume = true;
    let prompt: string;
    // An agent that died before Claude saved its conversation would just die again on --resume.
    const agentDied = s.status === 'active' || s.pauseReason === 'agent_exited';
    if (
      provider === 'claude' &&
      agentSessionId &&
      agentDied &&
      !(await this.conversationSaved(agentSessionId))
    ) {
      this.log(`session ${s.id}: no saved Claude conversation ${agentSessionId}; starting a new one`);
      agentSessionId = null;
    }
    if (provider === 'claude' && agentSessionId) {
      prompt = `Resumed: ${why}. Continue where you left off.`;
    } else {
      // OpenCode --continue picks the folder's last conversation, which may be stale or missing; a
      // Claude session without a conversation id starts a new, recorded one. Both get the full state.
      if (provider === 'claude') {
        agentSessionId = this.ids.uuid();
        resume = false;
      }
      if (provider === 'opencode' && options.fresh) resume = false;
      prompt = await this.continuationPrompt(s, why);
    }
    if (options.deliver) {
      // Written before the launch and named in the first prompt: typing into an agent that is still
      // starting up could be lost.
      await this.writeLoopFile(s, project, cwd, options.deliver.name, options.deliver.content);
      prompt = `${prompt}\n\n${sanitizeLine(options.deliver.sentence)}`;
    }
    const target = await this.launch(s.id, cwd, {
      provider,
      model: launchModel,
      permissionMode: DEFAULT_PERMISSION_MODE,
      resume,
      agentSessionId,
      effort: options.defaults ? s.effort : effortFor(s.rigor, s.effort),
      prompt,
    });
    return store.sessions.update(sessionId, {
      status: 'active',
      tmuxTarget: target,
      agentSessionId,
      provider,
      model,
    });
  }

  /**
   * Restarts a live Claude agent, continuing its conversation, so a model or effort chosen for it
   * (the Planner's plan) takes effect now instead of at its next resume. Does nothing unless the
   * session is active on Claude with its agent running, and its launch differs from what is stored
   * now; at most one relaunch per session per RELAUNCH_MIN_GAP_MS. The session's lock is held from
   * the stop to the new launch, so a pause by the human waits and then stands. A launch that fails
   * is retried once on the default model and effort; if that fails too the session stays paused
   * (agent_exited) with a history entry saying why.
   */
  relaunch(sessionId: number, why: string): Promise<Session> {
    return this.withLock(sessionId, async () => {
      const { store } = this.deps;
      const s = store.sessions.require(sessionId);
      if (s.provider !== 'claude' || s.status !== 'active' || !(await this.isAlive(s))) return s;
      const want = { model: s.models[BUILDER_AGENT]?.model ?? s.model, effort: effortFor(s.rigor, s.effort) };
      const had = this.launched.get(sessionId);
      if (had && had.model === want.model && had.effort === want.effort) return s;
      const now = this.now();
      if (now - (this.relaunchedAt.get(sessionId) ?? -Infinity) < RELAUNCH_MIN_GAP_MS) {
        this.log(`session ${sessionId}: relaunch skipped, the last one was less than a minute ago`);
        return s;
      }
      this.relaunchedAt.set(sessionId, now);
      await this.killOwnWindow(s);
      store.sessions.update(s.id, { status: 'paused', pauseReason: 'agent_exited', tmuxTarget: null });
      this.log(`session ${sessionId}: relaunched (${why})`);
      const note = (text: string) =>
        store.history.add({ projectId: s.projectId, sessionId: s.id, kind: 'decision', text });
      try {
        return await this.resumeNow(sessionId, { reason: why });
      } catch (err) {
        try {
          const back = await this.resumeNow(sessionId, { reason: why, defaults: true });
          note(
            `Session ${s.id}: relaunching the builder on ${want.model} failed (${errorMessage(err)}); it runs on its default model and effort instead.`,
          );
          return back;
        } catch (second) {
          note(
            `Session ${s.id}: relaunching the builder failed (${errorMessage(err)}), and so did the default model (${errorMessage(second)}). It is paused (agent exited).`,
          );
          return store.sessions.require(sessionId);
        }
      }
    });
  }

  /**
   * Types one line into the session's running agent and presses Enter. Meant for short, fixed
   * notices (the PR loop's "feedback is in <file>"), never for untrusted content: every control
   * character (C0 including tab, CR and LF, DEL, C1, ESC) and the Unicode line separators become
   * spaces, so nothing can submit early or send key sequences; text starting with "!" (shell mode)
   * or "/" (slash commands) is refused. Throws ValidationError unless the session is active and
   * local with a live agent window (a paused session gets nothing; callers retry once it runs).
   */
  sendToSession(sessionId: number, text: string): Promise<Session> {
    return this.withLock(sessionId, () => this.sendNow(sessionId, text));
  }

  /**
   * Hands the agent a file and tells it so: writes `content` to `.loop/<name>` in the agent's working
   * folder (mode 0600; `.loop/` is git-excluded), then types `sentence`, which should name
   * `.loop/<name>`, through the same checks as sendToSession. The file is inside the working folder
   * because agents in the default and auto permission modes may not read files outside it. Untrusted
   * text (review comments, test output) belongs in the file, never in the sentence. Returns the
   * file's path relative to the working folder.
   */
  deliverFile(sessionId: number, name: string, content: string, sentence: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name) || name.includes('..')) {
      return Promise.reject(new ValidationError(`unsafe file name "${name}"`));
    }
    return this.withLock(sessionId, async () => {
      const s = this.deps.store.sessions.require(sessionId);
      if (s.status === 'ended') throw new ValidationError(`session ${sessionId} has ended`);
      const project = this.deps.store.projects.require(s.projectId);
      const cwd = await this.sessionCwd(s, project);
      if (project.kind !== 'folder') assertInside(this.worktreesRoot, cwd, 'agent folder');
      const relative = await this.writeLoopFile(s, project, cwd, name, content);
      await this.sendNow(sessionId, sentence);
      return relative;
    });
  }

  /** Writes `.loop/<name>` in the agent's folder, never through a symlink, kept out of git status. */
  private async writeLoopFile(
    s: Session,
    project: Project,
    cwd: string,
    name: string,
    content: string,
  ): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name) || name.includes('..')) {
      throw new ValidationError(`unsafe file name "${name}"`);
    }
    try {
      const dir = join(cwd, LOOP_DIR);
      await this.deps.fs.writeFileNoFollow(dir, name, content, 0o600);
      // A folder may have no git exclude (or no git at all): keep .loop/ out of any repo it is in.
      if (project.kind === 'folder') await this.deps.fs.writeFileNoFollow(dir, '.gitignore', '*\n', 0o644);
    } catch (err) {
      // A branch can commit .loop or the file as a symlink to aim the write outside the worktree.
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new ValidationError(errorMessage(err));
      throw err;
    }
    // Single-repo sessions work inside the worktree; keep .loop/ out of its git status.
    const own = s.worktrees.find((wt) => wt.path === cwd);
    if (own) await this.addExcludes(own.path, [`/${LOOP_DIR}/`]);
    return `${LOOP_DIR}/${name}`;
  }

  private async sendNow(sessionId: number, text: string): Promise<Session> {
    const line = sanitizeLine(text);
    if (line === '') throw new ValidationError('nothing to send');
    if (line.startsWith('!') || line.startsWith('/')) {
      throw new ValidationError('text sent to an agent may not start with "!" or "/"');
    }
    const s = this.deps.store.sessions.require(sessionId);
    if (s.status !== 'active' || !s.tmuxTarget) {
      throw new ValidationError(`session ${sessionId} is ${s.status}; its agent is not running`);
    }
    if (!(await this.isAlive(s))) throw new ValidationError(`the agent of session ${sessionId} is gone`);
    await this.deps.tmux.sendKeys(s.tmuxTarget, line);
    return s;
  }

  /** Kills the agent and ends the session. Worktrees stay on disk; end() removes them. */
  stop(sessionId: number): Promise<Session> {
    return this.withLock(sessionId, () => this.stopNow(sessionId));
  }

  /**
   * Stops the session and removes its worktrees, session folder and runner state. Refuses (before
   * stopping anything) when a worktree has uncommitted changes, unless `force`; files the runner
   * wrote itself (env copies, the skill) do not count. The branch is kept: the PR loop deletes it.
   * A folder project's session has no worktrees: only the agent and the runner state go, and
   * nothing in the project folder is touched (its `.loop/` request files stay too).
   */
  end(sessionId: number, options: EndOptions = {}): Promise<Session> {
    return this.withLock(sessionId, () => this.endNow(sessionId, options));
  }

  /**
   * What a folder project's open session can do with a new request: "live" (its agent runs: deliver
   * to it), "resumable" (paused for the usage limit: resume, then deliver),
   * "paused-manual" (paused by the human: only they decide whether it resumes), "dead" (its
   * agent exited, or it never finished starting: end it and start fresh), or "ended". Waits for any
   * start, pause or resume of the session in progress.
   */
  sessionState(sessionId: number): Promise<'live' | 'resumable' | 'paused-manual' | 'dead' | 'ended'> {
    return this.withLock(sessionId, async () => {
      const s = this.deps.store.sessions.require(sessionId);
      if (s.status === 'ended') return 'ended';
      if (s.status === 'paused') {
        if (s.pauseReason === 'agent_exited') return 'dead';
        // Only the human undoes their own pause.
        return s.pauseReason === 'manual' ? 'paused-manual' : 'resumable';
      }
      return s.tmuxTarget && (await this.isAlive(s)) ? 'live' : 'dead';
    });
  }

  private async endNow(sessionId: number, options: EndOptions = {}): Promise<Session> {
    {
      const { store, git, fs } = this.deps;
      const s = store.sessions.require(sessionId);
      const project = store.projects.require(s.projectId);
      const present: Worktree[] = [];
      for (const wt of s.worktrees) {
        assertInside(this.worktreesRoot, wt.path, 'worktree');
        if (await fs.exists(wt.path)) present.push(wt);
      }
      if (!options.force) {
        // Plain `git status`: runner-written files are in info/exclude, so anything listed (including
        // edits to tracked env or skill paths) is the user's work.
        const dirty: string[] = [];
        for (const wt of present) if ((await git.status(wt.path)) !== '') dirty.push(wt.repo);
        if (dirty.length > 0) {
          throw new ValidationError(
            `session ${sessionId} has uncommitted changes in ${dirty.join(', ')}; commit them or end with force`,
          );
        }
      }
      const ended = await this.stopNow(sessionId);
      for (const wt of present) {
        const repo = project.repos.find((r) => r.name === wt.repo);
        // Not forced unless asked: git itself refuses if changes appeared after the check above.
        if (repo) await git.removeWorktree(repo.path, wt.path, { force: options.force });
      }
      await this.removeSessionDir(s.worktrees);
      await fs.remove(this.configDir(sessionId));
      return ended;
    }
  }

  /**
   * Usage-limit fallback: marks the session paused with "usage_limit", then relaunches it on OpenCode
   * with the fallback model from Settings and a continuation prompt, and records the provider switch
   * as a decision in the project history. Returns null when the session is not an active Claude
   * session. If the relaunch fails, the session stays paused, the failure is recorded, and it throws.
   */
  fallbackToOpencode(sessionId: number, detectedLine: string): Promise<Session | null> {
    return this.withLock(sessionId, async () => {
      const s = this.deps.store.sessions.require(sessionId);
      if (s.provider !== 'claude' || s.status !== 'active') return null;
      return this.fallbackNow(s, detectedLine);
    });
  }

  /** Reads the session's pane (inside the session lock) and falls back to OpenCode on a usage-limit message. */
  checkUsageLimit(sessionId: number, options: UsageCheckOptions = {}): Promise<Session | null> {
    return this.withLock(sessionId, async () => {
      const s = this.deps.store.sessions.require(sessionId);
      if (s.provider !== 'claude' || s.status !== 'active' || !s.tmuxTarget) return null;
      if (!(await this.isAlive(s))) return null; // reconcile handles it; never read another session's window
      const tail = options.tailLines ?? DEFAULT_TAIL_LINES;
      const pane = await this.deps.tmux.capture(s.tmuxTarget, tail * 4); // blank rows are dropped first
      const line = detectUsageLimit(pane, options.patterns ?? USAGE_LIMIT_PATTERNS, tail);
      return line ? this.fallbackNow(s, line) : null;
    });
  }

  /**
   * The screen of an active local OpenCode session's agent, and whether it is busy (its TUI shows
   * "esc interrupt" while it works). null when there is no such live agent.
   */
  readOpencodePane(sessionId: number): Promise<{ session: Session; busy: boolean; pane: string } | null> {
    return this.withLock(sessionId, async () => {
      const s = this.deps.store.sessions.require(sessionId);
      if (s.provider !== 'opencode' || s.status !== 'active' || !s.tmuxTarget) return null;
      if (!(await this.isAlive(s))) return null;
      const pane = await this.deps.tmux.capture(s.tmuxTarget, 200);
      return { session: s, busy: /esc interrupt/i.test(pane), pane };
    });
  }

  /**
   * Moves an OpenCode session to the next model (Settings: fallbackModel, then opencodeBackupModels,
   * then round again) and relaunches it, continuing its conversation. For a model that hit a limit,
   * errors or hangs. Records the move in the project history.
   */
  async rotateModel(sessionId: number, why: string): Promise<Session> {
    const moved = await this.withLock(sessionId, async () => {
      const { store } = this.deps;
      const s = store.sessions.require(sessionId);
      if (s.provider !== 'opencode' || s.status === 'ended') return null;
      const settings = store.settings.get();
      const chain = [...new Set([settings.fallbackModel, ...settings.opencodeBackupModels])];
      const model = chain[(chain.indexOf(s.model) + 1) % chain.length]!;
      await this.killOwnWindow(s);
      store.history.add({
        projectId: s.projectId,
        sessionId: s.id,
        kind: 'decision',
        text: `Session ${s.id} moved from ${s.model} to ${model}: ${why}.`,
      });
      store.sessions.update(s.id, { model, status: 'paused', pauseReason: 'agent_exited', tmuxTarget: null });
      return model;
    });
    if (moved === null) return this.deps.store.sessions.require(sessionId);
    this.log(`session ${sessionId}: moved to ${moved} (${why})`);
    return this.resume(sessionId, {
      reason: `the previous model ${why}; you now run on ${moved}`,
      fresh: true,
    });
  }

  /**
   * Whether the session's Claude agent is stuck at the folder-trust dialog (it waits there forever:
   * nobody watches the window). Returns the folder Claude asks about, or null. Read-only: trusting a
   * folder is the human's call, so the runner never answers the dialog.
   */
  checkTrustPrompt(sessionId: number): Promise<{ session: Session; folder: string } | null> {
    return this.withLock(sessionId, async () => {
      const s = this.deps.store.sessions.require(sessionId);
      if (s.provider !== 'claude' || s.status !== 'active' || !s.tmuxTarget) return null;
      if (!(await this.isAlive(s))) return null;
      const pane = await this.deps.tmux.capture(s.tmuxTarget, TRUST_TAIL_LINES * 4);
      if (!detectTrustPrompt(pane)) return null;
      const project = this.deps.store.projects.require(s.projectId);
      return { session: s, folder: await this.sessionCwd(s, project) };
    });
  }

  /**
   * Finds active sessions whose agent is gone (tmux window missing or its pane dead: the agent
   * exited, crashed or never started) and marks them paused with "agent_exited", with a history note.
   * Call it when the server starts; the monitor also runs it on every pass. Returns those sessions.
   */
  async reconcile(): Promise<Session[]> {
    const { store } = this.deps;
    const paused: Session[] = [];
    for (const candidate of store.sessions.list({ status: 'active' })) {
      const result = await this.withLock(candidate.id, async () => {
        const s = store.sessions.require(candidate.id);
        if (s.status !== 'active' || (await this.isAlive(s))) return null;
        await this.killOwnWindow(s);
        if (store.projects.get(s.projectId)?.kind === 'folder') {
          // A folder runs one session at a time: a paused dead session would block it until someone
          // noticed. Ending it touches nothing in the folder; the next request starts a fresh session.
          const ended = await this.endNow(s.id);
          store.history.add({
            projectId: s.projectId,
            sessionId: s.id,
            kind: 'decision',
            text:
              `The ${s.provider}/${s.model} agent of folder session ${s.id} is gone (tmux window ` +
              `${s.tmuxTarget ?? 'none'} closed or its process exited). Session ended so the folder is free; ` +
              'its files are untouched.',
          });
          return ended;
        }
        return store.transaction(() => {
          const updated = store.sessions.update(s.id, {
            status: 'paused',
            pauseReason: 'agent_exited',
            tmuxTarget: null,
          });
          store.history.add({
            projectId: s.projectId,
            sessionId: s.id,
            kind: 'decision',
            text:
              `The ${s.provider}/${s.model} agent of session ${s.id} is gone (tmux window ` +
              `${s.tmuxTarget ?? 'none'} closed or its process exited). Session paused (agent_exited); resume relaunches it.`,
          });
          return updated;
        });
      });
      if (result) paused.push(result);
    }
    return paused;
  }

  /** Origin's fresh tip of the default branch, so a session never starts from stale code; the local branch if the fetch fails. */
  private async baseRef(repo: Repo): Promise<string> {
    try {
      await this.deps.git.fetch(repo.path, repo.defaultBranch);
      return `origin/${repo.defaultBranch}`;
    } catch (err) {
      this.log(
        `${repo.name}: could not fetch origin/${repo.defaultBranch}, branching from the local ${repo.defaultBranch} (${errorMessage(err)})`,
      );
      return repo.defaultBranch;
    }
  }

  /** `sessionDir` is null for a folder project: the agent runs in its folder, nothing is created there. */
  private async provision(
    project: Project,
    session: Session,
    sessionDir: string | null,
    text: string,
    request: StartRequest,
  ): Promise<Session> {
    const { store, git, tmux, fs } = this.deps;
    const created: Worktree[] = [];
    let launched: string | null = null;
    try {
      let cwd: string;
      if (sessionDir === null) {
        cwd = await this.sessionCwd(session, project);
      } else {
        for (const repo of project.repos) {
          const path = join(sessionDir, repo.name);
          assertInside(sessionDir, path, 'worktree');
          await git.addWorktree(repo.path, path, session.branch, await this.baseRef(repo));
          created.push({ repo: repo.name, path });
        }
        store.sessions.update(session.id, { worktrees: created });
        cwd = agentCwd(created);
        await this.prepareWorktrees(project, created, cwd);
      }
      launched = await this.launch(session.id, cwd, {
        provider: session.provider,
        model:
          (session.provider === 'claude' ? session.models[BUILDER_AGENT]?.model : undefined) ?? session.model,
        permissionMode: DEFAULT_PERMISSION_MODE,
        prompt: text,
        ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
        title: session.title,
        effort: effortFor(session.rigor, session.effort),
      });
      const target = launched;
      const current = store.transaction(() => {
        if ('requestId' in request) store.requests.assignSession(request.requestId, session.id);
        else
          store.requests.create({
            projectId: project.id,
            text,
            source: request.source ?? 'dashboard',
            sessionId: session.id,
          });
        const s = store.sessions.require(session.id);
        return s.status === 'active' ? store.sessions.update(session.id, { tmuxTarget: target }) : s;
      });
      // Changed outside the runner while starting (e.g. ended from the dashboard): do not leave an agent running.
      if (current.tmuxTarget !== target) await tmux.kill(target);
      return current;
    } catch (err) {
      if (launched) await tmux.kill(launched).catch(() => undefined);
      for (const wt of created) {
        const repo = project.repos.find((r) => r.name === wt.repo);
        if (repo) await git.removeWorktree(repo.path, wt.path, { force: true }).catch(() => undefined);
      }
      // Branches did not exist before (checked in startSession), so any found now are ours, including
      // one a failed `worktree add` created before failing.
      for (const repo of project.repos) {
        if (await git.branchExists(repo.path, session.branch).catch(() => false)) {
          await git.deleteBranch(repo.path, session.branch).catch(() => undefined);
        }
      }
      if (sessionDir !== null) await fs.remove(sessionDir).catch(() => undefined);
      await fs.remove(this.configDir(session.id)).catch(() => undefined);
      store.sessions.update(session.id, { status: 'ended', worktrees: [], tmuxTarget: null });
      throw err;
    }
  }

  /**
   * Provider, model and conversation id for a new session: Claude on the session model when Claude
   * Code is switched on, else OpenCode on the fallback model (OpenCode keeps no conversation id).
   */
  private newAgent(model: string | undefined): Pick<Session, 'provider' | 'model' | 'agentSessionId'> {
    const settings = this.deps.store.settings.get();
    return enabledProvider(settings) === 'claude'
      ? { provider: 'claude', model: model ?? settings.sessionModel, agentSessionId: this.ids.uuid() }
      : { provider: 'opencode', model: settings.fallbackModel, agentSessionId: null };
  }

  private async fallbackNow(s: Session, detectedLine: string): Promise<Session> {
    const { store } = this.deps;
    await this.killOwnWindow(s);
    const paused = store.sessions.update(s.id, {
      status: 'paused',
      pauseReason: 'usage_limit',
      tmuxTarget: null,
    });
    const { fallbackModel, opencodeEnabled } = store.settings.get();
    if (!opencodeEnabled || this.onClaudeLimit === 'wait') {
      // Wait for the limit to reset instead of switching: free models stall on long building work.
      const why = opencodeEnabled ? 'builders wait for Claude' : 'OpenCode is switched off';
      store.history.add({
        projectId: s.projectId,
        sessionId: s.id,
        kind: 'decision',
        text: `Claude usage limit reached ("${detectedLine}"). ${why[0]!.toUpperCase()}${why.slice(1)}, so session ${s.id} stays paused (usage_limit) until Claude answers again.`,
      });
      return paused;
    }
    let target: string;
    try {
      const project = store.projects.require(s.projectId);
      const cwd = await this.sessionCwd(s, project);
      const prompt = await this.continuationPrompt(s, `Claude usage limit reached ("${detectedLine}")`);
      target = await this.launch(s.id, cwd, {
        provider: 'opencode',
        model: fallbackModel,
        permissionMode: DEFAULT_PERMISSION_MODE,
        prompt,
      });
    } catch (err) {
      store.history.add({
        projectId: s.projectId,
        sessionId: s.id,
        kind: 'decision',
        text:
          `Claude usage limit reached ("${detectedLine}"), but relaunching session ${s.id} on ` +
          `opencode/${fallbackModel} failed: ${errorMessage(err)}. Session left paused (usage_limit).`,
      });
      throw err;
    }
    return store.transaction(() => {
      const updated = store.sessions.update(s.id, {
        status: 'active',
        provider: 'opencode',
        model: fallbackModel,
        tmuxTarget: target,
        agentSessionId: null,
      });
      store.history.add({
        projectId: s.projectId,
        sessionId: s.id,
        kind: 'decision',
        text:
          `Claude usage limit reached ("${detectedLine}"). Session ${s.id} switched from claude/${s.model} ` +
          `(conversation ${s.agentSessionId ?? 'unknown'}) to opencode/${fallbackModel} with the same rights.`,
      });
      return updated;
    });
  }

  private async stopNow(sessionId: number): Promise<Session> {
    const s = this.deps.store.sessions.require(sessionId);
    await this.killOwnWindow(s);
    if (s.status === 'ended' && s.tmuxTarget === null) return s;
    return this.deps.store.sessions.update(sessionId, { status: 'ended', tmuxTarget: null });
  }

  /**
   * The session's window, matched by id and by name: tmux reuses window ids after a server restart,
   * so an old target alone could point at another session's window.
   */
  private async ownWindow(s: Session): Promise<TmuxWindow | undefined> {
    if (!s.tmuxTarget) return undefined;
    const tmuxSession = s.tmuxTarget.split(':')[0] ?? this.tmuxSession;
    return (await this.deps.tmux.list(tmuxSession)).find(
      (w) => w.target === s.tmuxTarget && w.name === windowName(s.id),
    );
  }

  private async isAlive(s: Session): Promise<boolean> {
    const window = await this.ownWindow(s);
    return window !== undefined && !window.dead;
  }

  private async killOwnWindow(s: Session): Promise<void> {
    const window = await this.ownWindow(s);
    if (window) await this.deps.tmux.kill(window.target);
  }

  /** Whether Claude saved conversation `id` (any project folder: the cwd encoding is Claude's). */
  private async conversationSaved(id: string): Promise<boolean> {
    const { fs } = this.deps;
    const dirs = await fs.list(this.claudeProjectsDir).catch(() => [] as string[]);
    for (const dir of dirs)
      if (await fs.exists(join(this.claudeProjectsDir, dir, `${id}.jsonl`))) return true;
    return false;
  }

  /** Where the session's agent runs: the project folder, or its worktree(s). */
  private async sessionCwd(s: Session, project: Project): Promise<string> {
    if (project.kind !== 'folder') return agentCwd(s.worktrees);
    await this.checkFolder(project);
    return project.folderPath ?? '';
  }

  /** A folder project's folder must still exist and stay clear of the runner's own folders. */
  private async checkFolder(project: Project): Promise<void> {
    const folder = project.folderPath;
    if (!folder || !isAbsolute(folder) || resolve(folder) !== folder || folder.includes('#')) {
      throw new ValidationError(`project ${project.name} has an invalid folder "${String(folder)}"`);
    }
    const { fs } = this.deps;
    for (const root of this.protectedRoots()) {
      const canonicalRoot = await fs.realpath(root).catch(() => root);
      if (pathsOverlap(folder, root) || pathsOverlap(folder, canonicalRoot)) {
        throw new ValidationError(`project folder ${folder} overlaps the runner folder ${root}`);
      }
    }
    if (!(await fs.exists(folder))) throw new ValidationError(`project folder ${folder} does not exist`);
    // Stored canonical at registration; anything else now means the folder was replaced by a symlink
    // (or renamed into another case), and the agent would follow it somewhere never checked.
    const real = await fs.realpath(folder);
    if (real !== folder) {
      throw new ValidationError(
        `project folder ${folder} now resolves to ${real} (replaced by a symlink or renamed); register it again`,
      );
    }
  }

  private async checkProject(project: Project): Promise<void> {
    if (project.kind === 'folder') {
      if (project.repos.length > 0 || project.envFiles.length > 0) {
        throw new ValidationError(`folder project ${project.name} cannot have repos or env files`);
      }
      return this.checkFolder(project);
    }
    // Core validates these on save; re-checked here for rows written before that validation existed.
    if (project.repos.length === 0) throw new ValidationError(`project ${project.name} has no repos`);
    for (const repo of project.repos) {
      if (!isSafeRepoName(repo.name)) throw new ValidationError(`unsafe repo name "${repo.name}"`);
      if (!isSafeBranchName(repo.defaultBranch)) {
        throw new ValidationError(`repo ${repo.name}: unsafe default branch "${repo.defaultBranch}"`);
      }
    }
    for (const file of project.envFiles) {
      if (!isSafeRelativePath(file.target))
        throw new ValidationError(`unsafe env file target "${file.target}"`);
    }
  }

  private async continuationPrompt(s: Session, reason: string): Promise<string> {
    const { git, store } = this.deps;
    const project = store.projects.require(s.projectId);
    if (project.kind === 'folder') {
      const requests = store.requests.list({ sessionId: s.id }).map((r) => r.text);
      return buildContinuationPrompt({
        requests,
        branch: '',
        repos: [],
        reason,
        folder: project.folderPath ?? '',
      });
    }
    const repos: RepoState[] = [];
    for (const wt of s.worktrees) {
      repos.push({
        repo: wt.repo,
        path: wt.path,
        status: await git.status(wt.path),
        diffStat: await git.diffStat(wt.path),
        recentCommits: await git.recentCommits(wt.path, 10),
      });
    }
    const [first] = s.worktrees;
    const branch = first ? await git.currentBranch(first.path) : s.branch;
    const requests = store.requests.list({ sessionId: s.id }).map((r) => r.text);
    return buildContinuationPrompt({ requests, branch, repos, reason });
  }

  private requireToken(): string {
    const token = this.env[this.tokenEnv];
    if (!token) throw new ValidationError(`${this.tokenEnv} is not set; sessions need it to reach ask_human`);
    return token;
  }

  private configDir(sessionId: number): string {
    return join(this.stateDir, `s${sessionId}`);
  }

  /** The session's standing rules (how to ask the human, how to finish), from the store only. */
  private instructions(sessionId: number): string {
    const { store } = this.deps;
    const s = store.sessions.require(sessionId);
    const project = store.projects.require(s.projectId);
    const planner = this.planner?.();
    const common = { sessionId, ...(planner ? { planner } : {}) };
    if (project.kind === 'folder') {
      return sessionInstructions({ ...common, kind: 'folder', folder: project.folderPath ?? '' });
    }
    return sessionInstructions({ ...common, kind: 'git', branch: s.branch, repos: project.repos });
  }

  /** Writes the session's configs, then a launch script, and runs it in a new tmux window. */
  private async launch(sessionId: number, cwd: string, spec: LaunchSpec): Promise<string> {
    const { fs, tmux, agentCli, store } = this.deps;
    const configDir = this.configDir(sessionId);
    if (spec.provider === 'claude')
      this.launched.set(sessionId, { model: spec.model, effort: spec.effort ?? null });
    const paths = await writeSessionConfig(fs, configDir, cwd, {
      serverUrl: this.serverUrl,
      sessionId,
      tokenEnv: this.tokenEnv,
      fallbackModel: spec.provider === 'opencode' ? spec.model : store.settings.get().fallbackModel,
      permissionMode: spec.permissionMode,
    });
    const argv = agentCli.build({
      ...spec,
      mcpConfigPath: paths.claudeMcp,
      systemPrompt: this.instructions(sessionId),
    });
    const env: Record<string, string> = {
      MCP_TOOL_TIMEOUT: String(this.mcpToolTimeoutMs),
      // The agent gets only its own session token, never the shared MCP_TOKEN (see sessionToken()).
      [this.tokenEnv]: sessionToken(this.requireToken(), sessionId),
      LOOP_SESSION_ID: String(sessionId),
      LOOP_SERVER_URL: this.serverUrl,
      OPENCODE_CONFIG: paths.opencode,
      OPENCODE_CONFIG_CONTENT: paths.opencodeInline,
    };
    for (const name of PASSTHROUGH_ENV) {
      const value = this.env[name];
      if (value) env[name] = value;
    }
    const scriptPath = join(configDir, `launch-${this.ids.suffix()}.sh`);
    await fs.writeFile(scriptPath, renderLaunchScript(argv, env, cwd), { mode: 0o600 });
    try {
      const target = await tmux.newWindow({
        session: this.tmuxSession,
        name: windowName(sessionId),
        cwd,
        command: `sh ${shellQuote(scriptPath)}`,
      });
      if (spec.provider === 'claude')
        this.launched.set(sessionId, { model: spec.model, effort: spec.effort ?? null });
      return target;
    } catch (err) {
      await fs.remove(scriptPath).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Copies env files and writes the skill, never over a file the repo tracks (that is skipped and
   * logged), and keeps what it wrote out of `git status` via info/exclude.
   */
  private async prepareWorktrees(project: Project, worktrees: Worktree[], cwd: string): Promise<void> {
    const { fs, git } = this.deps;
    for (const wt of worktrees) {
      const excludes: string[] = [];
      for (const file of project.envFiles.filter((f) => f.repo === wt.repo)) {
        if (await git.isTracked(wt.path, file.target)) {
          this.log(`not copying env file to ${wt.repo}/${file.target}: the repo tracks that path`);
          continue;
        }
        const target = join(wt.path, file.target);
        assertInside(wt.path, target, 'env file target');
        await fs.copyFile(file.source, target, { mode: 0o600 });
        excludes.push(`/${file.target}`);
      }
      if (wt.path === cwd) {
        if (await git.isTracked(wt.path, SKILL_DIR)) {
          this.log(`not writing the opensource-search skill in ${wt.repo}: the repo tracks ${SKILL_DIR}`);
        } else {
          await fs.writeFile(join(cwd, SKILL_FILE), OPENSOURCE_SEARCH_SKILL);
          excludes.push(`/${SKILL_DIR}/`);
        }
      }
      await this.addExcludes(wt.path, excludes);
    }
    // Multi-repo: the agent runs in the folder holding the worktrees, which is not a repo.
    if (!worktrees.some((wt) => wt.path === cwd))
      await fs.writeFile(join(cwd, SKILL_FILE), OPENSOURCE_SEARCH_SKILL);
  }

  /**
   * Appends anchored patterns to the repo's info/exclude. That file is shared by every worktree of
   * the repo (git has no per-worktree exclude without extra config); patterns are added once.
   */
  private async addExcludes(worktreePath: string, patterns: string[]): Promise<void> {
    if (patterns.length === 0) return;
    const { fs, git } = this.deps;
    const path = await git.excludeFile(worktreePath);
    const current = (await fs.exists(path)) ? await fs.readFile(path) : '';
    const have = new Set(current.split('\n'));
    const missing = patterns.filter((p) => !have.has(p));
    if (missing.length === 0) return;
    const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
    await fs.writeFile(path, `${prefix}# loop-engineering runner\n${missing.join('\n')}\n`);
  }

  /** Removes the folder holding a session's worktrees, only when it is laid out as the runner made it. */
  private async removeSessionDir(worktrees: Worktree[]): Promise<void> {
    const [first] = worktrees;
    if (!first) return;
    const dir = dirname(first.path);
    const ours = worktrees.every((wt) => resolve(wt.path) === resolve(join(dir, wt.repo)));
    if (ours && isInside(this.worktreesRoot, dir)) await this.deps.fs.remove(dir);
  }

  private withLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId);
    });
    return next;
  }
}
