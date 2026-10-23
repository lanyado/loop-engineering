import { tmpdir } from 'node:os';
import type { Clock } from '@loop-engineering/core';
import {
  detectUsageLimit,
  opencodePermission,
  parseClaudeOutput,
  parseOpencodeOutput,
  runCommand,
  type RunResult,
  type Runner,
} from '@loop-engineering/runner';
import { extractJson } from './classification.js';
import {
  buildClassifierPrompt,
  buildSplitPrompt,
  buildTitlePrompt,
  cleanPlan,
  cleanTitle,
  type Plan,
} from './prompt.js';
import type { Classifier, ClassifyInput } from './types.js';

export interface CliClassifierOptions {
  /** Model fallback when Claude is out of usage; read on every call (Settings.fallbackModel). */
  fallbackModel: () => string;
  clock: Clock;
  /** Claude model. Default "haiku": classification is a small, cheap job. */
  model?: string;
  /** After a usage-limit answer, go straight to OpenCode for this long. Default 15 minutes. */
  limitCooldownMs?: number;
  claudeBin?: string;
  opencodeBin?: string;
  /** Which CLIs are switched on (Settings); default both. */
  providers?: () => { claude: boolean; opencode: boolean };
  run?: Runner;
  log?: (message: string) => void;
}

export class ClassifierError extends Error {
  override name = 'ClassifierError';
}

/**
 * Classifies with one headless, tool-less Claude call (`claude -p --model haiku --output-format
 * json`), falling back to `opencode run --format json -m <fallback model>` while Claude is out of
 * usage. Resolves with the parsed JSON answer (unvalidated: the router validates it), or rejects.
 */
export class CliClassifier implements Classifier {
  private limitedUntil = 0;
  private readonly run: Runner;
  private readonly log: (message: string) => void;

  constructor(private readonly options: CliClassifierOptions) {
    this.run = options.run ?? runCommand;
    this.log = options.log ?? ((m) => console.log(m));
  }

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<unknown> {
    return this.ask(buildClassifierPrompt(input), signal);
  }

  /** A short session title for a task, in the task's language; null when the answer has none. */
  async title(text: string, signal: AbortSignal): Promise<string | null> {
    const answer = (await this.ask(buildTitlePrompt(text), signal)) as { title?: unknown } | null;
    return cleanTitle(answer?.title);
  }

  /** The independent parts of a task (fewer than two means one task), or a real question for the human. */
  async plan(text: string, signal: AbortSignal): Promise<Plan> {
    return cleanPlan(await this.ask(buildSplitPrompt(text), signal));
  }

  /** One JSON answer to `prompt`: Claude first, OpenCode while Claude is out of usage or off. */
  private async ask(prompt: string, signal: AbortSignal): Promise<unknown> {
    const now = this.options.clock.now().getTime();
    const on = this.options.providers?.() ?? { claude: true, opencode: true };
    if (on.claude && now >= this.limitedUntil) {
      const claude = await this.claude(prompt, signal);
      if (claude.kind === 'answer') return claude.json;
      if (claude.kind === 'error') throw new ClassifierError(claude.message);
      this.limitedUntil = now + (this.options.limitCooldownMs ?? 15 * 60_000);
      if (!on.opencode)
        throw new ClassifierError(`Claude is out of usage (${claude.message}) and OpenCode is switched off`);
      this.log(`[router] Claude is out of usage (${claude.message}); classifying with OpenCode`);
    } else if (!on.opencode) {
      throw new ClassifierError('Claude is out of usage and OpenCode is switched off');
    }
    return this.opencode(prompt, signal);
  }

  private async claude(
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ kind: 'answer'; json: unknown } | { kind: 'limited' | 'error'; message: string }> {
    const args = [
      '-p',
      '--model',
      this.options.model ?? 'haiku',
      '--output-format',
      'json',
      // As bare as the CLI allows while keeping the normal login: no tools, no MCP servers (strict,
      // and none given), no saved conversation, and --safe-mode turns off CLAUDE.md, skills,
      // plugins, hooks, custom commands, agents and output styles. Not disabled: settings.json
      // (permissions, env, apiKeyHelper may be what makes auth work) and Claude Code's built-in
      // system prompt. --bare would also skip those but turns off keychain/OAuth login.
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--safe-mode',
      '--disable-slash-commands',
    ];
    // A neutral working directory, so no repository's CLAUDE.md is pulled in.
    const out = await this.run(this.options.claudeBin ?? 'claude', args, {
      cwd: tmpdir(),
      input: prompt,
      signal,
    });
    const { text, isError } = parseClaudeOutput(out.stdout, out.stderr);
    if (out.code !== 0 || isError || !text) {
      const limit = detectUsageLimit(`${text}\n${out.stderr}`) ?? detectUsageLimit(out.stdout);
      if (limit) return { kind: 'limited', message: limit };
      return { kind: 'error', message: `claude failed (${String(out.code)}): ${describe(out, text)}` };
    }
    const json = extractJson(text);
    if (json === undefined)
      return { kind: 'error', message: `claude answered without JSON: ${text.slice(0, 200)}` };
    return { kind: 'answer', json };
  }

  private async opencode(prompt: string, signal: AbortSignal): Promise<unknown> {
    const config = { $schema: 'https://opencode.ai/config.json', permission: opencodePermission('dontAsk') };
    const out = await this.run(
      this.options.opencodeBin ?? 'opencode',
      ['run', '--format', 'json', '-m', this.options.fallbackModel(), '--', prompt],
      { cwd: tmpdir(), env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, signal },
    );
    const { text } = parseOpencodeOutput(out.stdout, out.stderr);
    const json = extractJson(text);
    if (out.code !== 0 || json === undefined) {
      throw new ClassifierError(`opencode failed (${String(out.code)}): ${describe(out, text)}`);
    }
    return json;
  }
}

function describe(out: RunResult, text: string): string {
  return (text || out.stderr || out.stdout).trim().slice(0, 300) || 'no output';
}
