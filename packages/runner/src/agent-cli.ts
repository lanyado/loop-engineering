import { assertModelArg, type Effort, type PermissionMode, type Provider } from '@loop-engineering/core';

export interface LaunchSpec {
  provider: Provider;
  model: string;
  permissionMode: PermissionMode;
  /** Initial message for the agent. */
  prompt?: string;
  /** Claude: the conversation id to create (`--session-id`) or, with `resume`, to resume. */
  agentSessionId?: string | null;
  /** Continue the previous conversation instead of starting a new one. */
  resume?: boolean;
  /** Claude: the runner's MCP config file (kept outside the worktree), loaded with --mcp-config. */
  mcpConfigPath?: string;
  /**
   * The session rules (instructions.ts). Claude: appended to the system prompt (survives compaction).
   * OpenCode: put at the top of the first message.
   */
  systemPrompt?: string;
  title?: string;
  effort?: Effort | null;
}

/** Builds the argv that launches an agent CLI. Pure: nothing is run here. */
export interface AgentCli {
  build(spec: LaunchSpec): string[];
}

export interface AgentBinaries {
  /** Default "claude". Tests point these at fake agent scripts. */
  claude?: string;
  /** Default "opencode". */
  opencode?: string;
}

export class DefaultAgentCli implements AgentCli {
  private readonly claudeBin: string;
  private readonly opencodeBin: string;

  constructor(bins: AgentBinaries = {}) {
    this.claudeBin = bins.claude ?? 'claude';
    this.opencodeBin = bins.opencode ?? 'opencode';
  }

  build(spec: LaunchSpec): string[] {
    return spec.provider === 'claude' ? this.claude(spec) : this.opencode(spec);
  }

  private claude(spec: LaunchSpec): string[] {
    const argv = [this.claudeBin];
    if (spec.resume) {
      if (!spec.agentSessionId) throw new Error('resuming a Claude session needs its agentSessionId');
      argv.push('--resume', spec.agentSessionId);
    } else if (spec.agentSessionId) {
      argv.push('--session-id', spec.agentSessionId);
    }
    argv.push('--model', assertModelArg(spec.model), '--permission-mode', spec.permissionMode);
    // --strict-mcp-config: exactly the servers the runner wrote, and no "trust this .mcp.json?" prompt.
    if (spec.mcpConfigPath) argv.push('--mcp-config', spec.mcpConfigPath, '--strict-mcp-config');
    if (spec.effort) argv.push('--effort', spec.effort);
    if (spec.systemPrompt) argv.push('--append-system-prompt', spec.systemPrompt);
    if (spec.title && !spec.resume) argv.push('--name', spec.title);
    // "--" ends the variadic --mcp-config list, so the prompt is never read as a config file.
    if (spec.prompt) argv.push('--', spec.prompt);
    return argv;
  }

  private opencode(spec: LaunchSpec): string[] {
    // --standalone: a private server started from this process, so it gets the launch env (token,
    // OPENCODE_CONFIG) and dies with the window, instead of the shared background service.
    // The TUI has no --model flag: model, MCP servers and permissions come from OPENCODE_CONFIG.
    const argv = [this.opencodeBin, '--standalone'];
    if (spec.resume) argv.push('--continue');
    // --auto approves whatever the config leaves at "ask". Auto mode too: an unwatched terminal must
    // never stop on a prompt (the config already denies the risky calls, and --auto keeps denies).
    if (spec.permissionMode === 'bypassPermissions' || spec.permissionMode === 'auto') argv.push('--auto');
    // No system-prompt flag: the session rules (systemPrompt) head the first message instead.
    const prompt = [spec.systemPrompt, spec.prompt].filter(Boolean).join('\n\n');
    if (prompt) argv.push(`--prompt=${prompt}`);
    return argv;
  }
}
