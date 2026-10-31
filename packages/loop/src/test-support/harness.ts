import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTimers, QuestionBus, QuestionService } from '@loop-engineering/ask-human';
import {
  FakeClock,
  openStore,
  type Project,
  type PullRequest,
  type Session,
  type Store,
} from '@loop-engineering/core';
import {
  DefaultAgentCli,
  FakeGitDriver,
  FakeTmuxDriver,
  MemoryFs,
  SessionRunner,
} from '@loop-engineering/runner';
import { LoopEngine, type LoopConfig, type LoopDeps } from '../engine.js';
import { FakeAgentLauncher, FakeDeployments, FakeGitHub, FakeWorkspace, verdictResult } from '../fakes.js';
import type { AgentJobResult } from '../ports.js';

export const SLUG = 'me/web';
export const REQUEST = 'Add Apple Pay to the checkout page';

export const clean = (extra: Partial<AgentJobResult> = {}) =>
  verdictResult(
    { verdict: 'approve', blocking: [], nonBlocking: ['nit: rename x'], unhandled: [], summary: 'fine' },
    extra,
  );
export const blocking = (...items: string[]) =>
  verdictResult({
    verdict: 'changes',
    blocking: items,
    nonBlocking: [],
    unhandled: [],
    summary: 'needs work',
  });
export const testsPass = (extra: { qaNeeded?: boolean; qaReason?: string; addedTests?: string[] } = {}) =>
  verdictResult({
    passed: true,
    failures: [],
    addedTests: [],
    qaNeeded: false,
    qaReason: 'backend only',
    summary: 'green',
    ...extra,
  });
export const testsFail = (...failures: string[]) =>
  verdictResult({ passed: false, failures, addedTests: [], qaNeeded: false, qaReason: '', summary: 'red' });
export const qaPass = () => verdictResult({ passed: true, failures: [], summary: 'checked checkout' });
export const qaFail = (...failures: string[]) =>
  verdictResult({ passed: false, failures, summary: 'broken' });

export interface HarnessOptions {
  autoMerge?: boolean;
  vercelProject?: string;
  productionUrl?: string;
  config?: Partial<LoopConfig>;
  /** Back the store with a file, so rebuild() can reopen it like a restarted server. */
  file?: boolean;
  deps?: Partial<LoopDeps>;
}

export class Harness {
  readonly clock = new FakeClock('2026-10-18T09:00:00.000Z');
  readonly timers = new FakeTimers(this.clock);
  readonly fs = new MemoryFs();
  readonly git = new FakeGitDriver(this.fs);
  readonly tmux = new FakeTmuxDriver();
  readonly github = new FakeGitHub();
  readonly launcher = new FakeAgentLauncher();
  readonly deployments = new FakeDeployments();
  readonly workspace = new FakeWorkspace();
  readonly logs: string[] = [];
  /** Every line the loop typed into a builder session. */
  readonly sent: { sessionId: number; text: string; file: string }[] = [];
  readonly dir: string | null;
  store!: Store;
  bus!: QuestionBus;
  questions!: QuestionService;
  runner!: SessionRunner;
  engine!: LoopEngine;
  project!: Project;
  private n = 0;

  constructor(private readonly options: HarnessOptions = {}) {
    this.dir = options.file ? mkdtempSync(join(tmpdir(), 'loop-engine-')) : null;
    this.build();
    this.project = this.store.projects.create({
      name: 'Shop',
      autoMerge: options.autoMerge ?? true,
      repos: [
        {
          name: 'web',
          path: '/src/web',
          remote: 'git@github.com:me/web.git',
          defaultBranch: 'main',
          ...(options.vercelProject ? { vercelProject: options.vercelProject } : {}),
          ...(options.productionUrl ? { productionUrl: options.productionUrl } : {}),
        },
      ],
    });
  }

  /** (Re)creates the store, question service, runner and engine; the fakes (GitHub, tmux, ...) persist. */
  private build(): void {
    this.store = openStore({ clock: this.clock, ...(this.dir ? { path: join(this.dir, 'loop.db') } : {}) });
    this.bus = new QuestionBus({
      onListenerError: (e) => {
        throw e;
      },
    });
    this.questions = new QuestionService(this.store, this.bus);
    this.runner = new SessionRunner(
      {
        store: this.store,
        fs: this.fs,
        git: this.git,
        tmux: this.tmux,
        agentCli: new DefaultAgentCli(),
        ids: {
          uuid: () => `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`,
          suffix: () => `x${++this.n}`,
        },
        log: (m) => this.logs.push(m),
        sleep: () => Promise.resolve(),
      },
      {
        worktreesRoot: '/wt',
        serverUrl: 'http://srv',
        claudeProjectsDir: '/claude',
        env: { MCP_TOKEN: 'tok' },
      },
    );
    this.engine = new LoopEngine(
      {
        store: this.store,
        runner: {
          pause: (...args) => this.runner.pause(...args),
          end: (...args) => this.runner.end(...args),
          stop: (...args) => this.runner.stop(...args),
          resume: async (sessionId, options) => {
            const session = await this.runner.resume(sessionId, options);
            if (options?.deliver)
              this.sent.push({ sessionId, text: options.deliver.sentence, file: options.deliver.content });
            return session;
          },
          deliverFile: async (sessionId, name, content, sentence) => {
            const path = await this.runner.deliverFile(sessionId, name, content, sentence);
            this.sent.push({ sessionId, text: sentence, file: content });
            return path;
          },
        },
        questions: this.questions,
        github: this.github,
        launcher: this.launcher,
        deployments: this.deployments,
        workspace: this.workspace,
        timers: this.timers,
        log: (m) => this.logs.push(m),
        ...this.options.deps,
      },
      this.options.config,
    );
  }

  /** Simulates a server restart: stops the engine, closes and reopens the store file, new engine. */
  async rebuild(): Promise<void> {
    if (!this.dir) throw new Error('rebuild needs a file-backed harness');
    await this.engine.stop();
    this.store.close();
    this.build();
    this.project = this.store.projects.require(this.project.id);
  }

  close(): void {
    this.store.close();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  setAutoMerge(on: boolean): void {
    this.project = this.store.projects.update(this.project.id, { autoMerge: on });
  }

  /** A builder session that opened a PR on its branch. */
  async builderWithPr(text = REQUEST): Promise<{ session: Session; number: number }> {
    const session = await this.runner.startSession(this.project.id, { text });
    const pr = this.github.open(SLUG, { branch: session.branch, title: 'Add Apple Pay' });
    return { session, number: pr.number };
  }

  pr(number = 1): PullRequest {
    const pr = this.store.pullRequests.getByNumber(this.project.id, 'web', number);
    if (!pr) throw new Error(`PR #${number} is not tracked`);
    return pr;
  }

  /** What the builder's agent window received so far (empty once the session ended). */
  keys(session: Session): string {
    const s = this.store.sessions.require(session.id);
    return s.tmuxTarget ? (this.tmux.windows.get(s.tmuxTarget)?.keys ?? '') : '';
  }

  /** Questions the loop asked, newest first. */
  asked() {
    return this.store.questions.list();
  }

  answer(questionId: number, text: string): void {
    this.questions.answer(questionId, text, 'dashboard');
  }
}
