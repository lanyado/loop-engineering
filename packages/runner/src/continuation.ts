export interface RepoState {
  repo: string;
  path: string;
  /** `git status --short`; empty when clean. */
  status: string;
  diffStat: string;
  recentCommits: string[];
}

export interface ContinuationInput {
  /** The human's request texts for this session, oldest first. */
  requests: string[];
  branch: string;
  repos: RepoState[];
  /** Why the previous agent stopped, e.g. the usage-limit line. */
  reason: string;
  /** A folder project's folder: the agent edits it in place, with no branch, worktree or PR. */
  folder?: string;
}

const MAX_LINES = 60;

function capped(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_LINES) return text;
  return [...lines.slice(0, MAX_LINES), `… (${lines.length - MAX_LINES} more lines)`].join('\n');
}

/** First message for an agent taking over a session another agent started. */
export function buildContinuationPrompt(input: ContinuationInput): string {
  const out: string[] = [
    'You are taking over a coding session from a Claude Code agent that had to stop.',
    `Reason: ${input.reason}`,
  ];
  const request = [
    '## Original request',
    '',
    ...(input.requests.length > 0 ? input.requests.map((r) => r.trim()) : ['(not recorded)']),
  ];
  if (input.folder !== undefined) {
    out.push(
      'Continue the work from where it stands, with the same rights as the previous agent. Use the',
      'ask_human MCP tool when you need a decision from the human.',
      '',
      ...request,
      '',
      '## Folder',
      '',
      `${input.folder}: you edit the files here in place. There is no branch, worktree or pull request,`,
      'so look at the files to see what the previous agent already changed before going on.',
    );
    return out.join('\n');
  }
  out.push(
    'Continue the work from where it stands, with the same rights as the previous agent, and finish it',
    'as the session rules say (commit, push, open a pull request; never merge). Use the ask_human MCP',
    'tool when you need a decision from the human, and follow the opensource-search skill before writing',
    'a new module.',
    '',
    ...request,
    '',
    '## Branch',
    '',
    `${input.branch} (checked out in every worktree below)`,
  );
  for (const repo of input.repos) {
    out.push(
      '',
      `## Repo ${repo.repo} (${repo.path})`,
      '',
      '### Uncommitted changes',
      '',
      repo.status ? capped(repo.status) : '(none)',
    );
    if (repo.status && repo.diffStat) out.push('', capped(repo.diffStat));
    out.push(
      '',
      '### Recent commits',
      '',
      repo.recentCommits.length > 0 ? repo.recentCommits.join('\n') : '(none)',
    );
  }
  out.push(
    '',
    'Start by reading `git status` and `git diff` in each worktree, then carry on with the request.',
  );
  return out.join('\n');
}
