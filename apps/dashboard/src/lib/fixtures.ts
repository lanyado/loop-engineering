import type {
  ClaudeUsage,
  Metrics,
  PipelineView,
  Stage,
  Project,
  PullRequest,
  Question,
  Settings,
  Subagent,
  TaskRequest,
  Transcript,
  TreeProject,
  TreeSession,
} from './schemas';

export interface DemoData {
  projects: Project[];
  tree: TreeProject[];
  questions: Question[];
  pullRequests: PullRequest[];
  requests: TaskRequest[];
  /** Stored transcripts the finished rows' View button shows, by session id. */
  transcripts: Record<number, Transcript>;
  settings: Settings;
  usage: ClaudeUsage;
  pipeline: PipelineView;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const QUESTION_TIMEOUT = 15 * MIN;

/**
 * Realistic sample data for demo mode (no SERVER_URL), with times relative to `now` so the
 * question countdowns and session run times look live on every load.
 */
export function demoData(now: Date): DemoData {
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  const projects: Project[] = [
    project(1, 'shop', ['web', 'api'], { autoMerge: false, markedForDirectInput: true }, at(30 * 24 * HOUR)),
    project(2, 'blog', ['site'], { autoMerge: true, markedForDirectInput: true }, at(20 * 24 * HOUR)),
    project(
      3,
      'infra',
      ['terraform'],
      { autoMerge: false, markedForDirectInput: false, permissionMode: 'plan' },
      at(9 * 24 * HOUR),
    ),
    {
      ...project(4, 'resume', [], { autoMerge: false, markedForDirectInput: true }, at(2 * 24 * HOUR)),
      kind: 'folder',
      folderPath: '/Users/demo/resume',
    },
  ];

  const sub = (id: number, sessionId: number, title: string, model: string, effort: string, status: string) =>
    ({ id, sessionId, title, model, effort, status, createdAt: at(id * 7 * MIN) }) satisfies Subagent;

  const sessions: TreeSession[] = [
    session(101, 1, 'Apple Pay checkout', 'active', null, 'claude', 'opus', at(3 * HOUR + 12 * MIN), {
      pendingQuestions: 2,
      branch: 'loop/apple-pay',
      subagents: [
        sub(1001, 101, 'Payment sheet UI', 'sonnet', 'high', 'running'),
        sub(1002, 101, 'Stripe webhook handler', 'sonnet', 'xhigh', 'waiting'),
        sub(1003, 101, 'Checkout e2e tests', 'haiku', 'medium', 'done'),
      ],
    }),
    session(102, 1, 'Search relevance', 'paused', 'agent_exited', 'claude', 'opus', at(26 * HOUR), {
      pendingQuestions: 1,
      branch: 'loop/search-relevance',
      subagents: [sub(1004, 102, 'Ranking experiment', 'sonnet', 'high', 'waiting')],
    }),
    session(103, 1, 'Order export CSV', 'ended', null, 'claude', 'opus', at(4 * 24 * HOUR), {
      branch: 'loop/order-export',
      endedAt: at(3 * 24 * HOUR),
      subagents: [sub(1005, 103, 'CSV writer', 'sonnet', 'medium', 'done')],
    }),
    session(
      201,
      2,
      'RSS feed + dark mode',
      'active',
      null,
      'opencode',
      'opencode/glm-5.3-flash-free',
      at(48 * MIN),
      {
        pendingQuestions: 1,
        branch: 'loop/rss-dark-mode',
        subagents: [sub(1006, 201, 'Theme tokens', 'opencode/glm-5.3-flash-free', 'medium', 'running')],
      },
    ),
    session(202, 2, 'Image CDN migration', 'paused', 'manual', 'claude', 'opus', at(9 * HOUR), {
      branch: 'loop/image-cdn',
      subagents: [],
    }),
    session(301, 3, 'Staging DB upgrade plan', 'paused', 'usage_limit', 'claude', 'opus', at(5 * HOUR), {
      branch: 'loop/pg17',
      subagents: [sub(1007, 301, 'Upgrade runbook', 'opus', 'max', 'failed')],
    }),
    session(401, 4, 'Update resume for the Acme role', 'active', null, 'claude', 'opus', at(20 * MIN), {
      branch: '',
      subagents: [],
    }),
  ];

  // Past Claude Code conversations brought in by the importer: ended, no branch, oldest first by id.
  const pastTitles = [
    'Tailor the resume for a staff engineer role',
    'Shorten the summary to three lines',
    'Rewrite the Acme bullet points with numbers',
    'Draft a cover letter for the Globex opening',
    'Fix the PDF export margins',
    'Translate the resume to Hebrew',
    'Add the open-source section',
    'Check the dates of every role',
    'Make a one-page version',
    'Proofread the education section',
    'Reorder skills by relevance',
    'Write a LinkedIn About section',
    'Turn the side project into a bullet',
    'Remove the oldest role',
    'Align fonts in the header',
    'Add the certification from June',
    'Draft a thank-you note after the interview',
    'Tune keywords for the job post',
    'Prepare talking points for the recruiter call',
    'Compare two summary drafts',
    'Polish the final version',
    'Export a plain-text copy',
    'Archive the old drafts',
  ];
  pastTitles.forEach((title, i) => {
    const age = (pastTitles.length - i) * 26 * HOUR;
    sessions.push(
      session(450 + i, 4, title, 'ended', null, 'claude', 'claude-opus-4-1', at(age + 40 * MIN), {
        branch: '',
        source: 'import',
        effort: null,
        endedAt: at(age),
        subagents: [],
      }),
    );
  });

  const tree: TreeProject[] = projects.map((p) => ({
    ...p,
    sessions: sessions.filter((s) => s.projectId === p.id).sort((a, b) => b.id - a.id),
  }));

  const pending = (
    id: number,
    sessionId: number,
    subagentId: number | null,
    askedAgo: number,
    text: string,
    options: string[],
    recommendedOption: string,
    context: string | null = null,
  ): Question => ({
    id,
    sessionId,
    subagentId,
    text,
    context,
    options,
    recommendedOption,
    status: 'pending',
    answer: null,
    answeredVia: null,
    createdAt: at(askedAgo),
    deadline: at(askedAgo - QUESTION_TIMEOUT),
    answeredAt: null,
  });

  const questions: Question[] = [
    pending(
      51,
      101,
      1002,
      12 * MIN,
      'Stripe sends the same webhook twice sometimes. Dedupe by event id in Postgres or in Redis?',
      ['Postgres table', 'Redis SET with TTL', 'Both'],
      'Postgres table',
      'We already run Postgres; Redis is only used for sessions today. Dedup keys need ~7 days retention.',
    ),
    pending(
      52,
      201,
      1006,
      6 * MIN,
      'Dark mode: follow the OS setting, or add a toggle in the header?',
      [
        'Follow OS',
        'Header toggle',
        'Both (OS default + toggle)',
        // Agents' options are often paths or URLs with no spaces; the layout must wrap them.
        'apps/blog/src/styles/themes/generated/dark-mode-tokens.from-figma.v2.css',
      ],
      'Both (OS default + toggle)',
    ),
    pending(
      54,
      102,
      null,
      3 * MIN,
      'PR api#85 passed review, tests and QA. Merge it? (auto-merge is off for shop)',
      ['Merge', 'Hold'],
      'Hold',
      'https://github.com/example/api/pull/85',
    ),
    pending(
      53,
      101,
      null,
      1 * MIN,
      'PR #212 passed review and tests. QA found the Apple Pay button misaligned on iPhone SE. Fix now or ship and follow up?',
      ['Fix in this PR', 'Ship, follow-up PR'],
      'Fix in this PR',
    ),
    {
      id: 50,
      sessionId: 102,
      subagentId: 1004,
      text: 'Use BM25 or embeddings for the first ranking pass?',
      context: null,
      options: ['BM25', 'Embeddings'],
      recommendedOption: 'BM25',
      status: 'answered',
      answer: 'BM25',
      answeredVia: 'telegram',
      createdAt: at(70 * MIN),
      deadline: at(55 * MIN),
      answeredAt: at(64 * MIN),
    },
    {
      id: 49,
      sessionId: 301,
      subagentId: 1007,
      text: 'Run the upgrade in the Sunday maintenance window?',
      context: null,
      options: ['Sunday 02:00', 'Next weekday night'],
      recommendedOption: 'Sunday 02:00',
      status: 'defaulted',
      answer: 'Sunday 02:00',
      answeredVia: 'timeout',
      createdAt: at(5 * HOUR),
      deadline: at(5 * HOUR - QUESTION_TIMEOUT),
      answeredAt: at(5 * HOUR - QUESTION_TIMEOUT),
    },
  ];

  const requests: TaskRequest[] = [
    request(
      14,
      null,
      null,
      'Rotate the staging DB password and update the env files',
      'dashboard',
      at(4 * MIN),
    ),
    request(13, 2, 201, 'Add an RSS feed and a dark mode', 'telegram', at(50 * MIN)),
    request(12, 1, 101, 'Support Apple Pay at checkout', 'telegram', at(3 * HOUR + 15 * MIN)),
    request(11, 1, 102, 'Search results feel random for short queries', 'dashboard', at(26 * HOUR)),
    request(10, 2, 202, 'Serve blog images from the CDN', 'telegram', at(9 * HOUR)),
    request(9, 1, 103, 'Let admins export orders as CSV', 'dashboard', at(4 * 24 * HOUR)),
  ];
  const byId = new Map(requests.map((r) => [r.id, r]));

  const pr = (
    id: number,
    projectId: number,
    sessionId: number,
    requestId: number | null,
    repo: string,
    number: number,
    stage: string,
    round: number,
    outcome: string | null,
    updatedAgo: number,
    m: Omit<Metrics, 'prId' | 'rounds'>,
    loopState: PullRequest['loopState'] = {},
  ): PullRequest => ({
    id,
    projectId,
    sessionId,
    requestId,
    repo,
    number,
    url: `https://github.com/example/${repo}/pull/${number}`,
    stage,
    round,
    outcome,
    loopState,
    createdAt: at(updatedAgo + 2 * HOUR),
    updatedAt: at(updatedAgo),
    request: requestId === null ? null : (byId.get(requestId) ?? null),
    metrics: { prId: id, rounds: round, ...m },
  });

  const pullRequests: PullRequest[] = [
    pr(
      7,
      1,
      101,
      12,
      'web',
      212,
      'qa',
      2,
      null,
      2 * MIN,
      {
        costUsd: 3.42,
        tokensIn: 1_840_000,
        tokensOut: 96_000,
        failures: 1,
      },
      {
        // The QA stage sent bugs back to the builder; they wait in the worktree for the fix.
        feedback: {
          kind: 'qa',
          items: [
            'The Apple Pay button is misaligned on iPhone SE (320px wide).',
            'The sheet opens behind the keyboard on Safari iOS: move focus off the first field.',
          ],
          sentAt: at(6 * MIN),
        },
      },
    ),
    pr(8, 1, 101, 12, 'api', 87, 'review', 1, null, 9 * MIN, {
      costUsd: 1.18,
      tokensIn: 610_000,
      tokensOut: 31_000,
      failures: 0,
    }),
    pr(9, 2, 201, 13, 'site', 45, 'tests', 3, null, 20 * MIN, {
      costUsd: 0,
      tokensIn: 920_000,
      tokensOut: 54_000,
      failures: 2,
    }),
    pr(
      6,
      1,
      102,
      11,
      'api',
      85,
      'awaiting_approval',
      2,
      null,
      40 * MIN,
      { costUsd: 2.05, tokensIn: 1_120_000, tokensOut: 61_000, failures: 0 },
      { question: { kind: 'approval', id: 54 } },
    ),
    // Search relevance's first PR, shipped: its row lists it under "Earlier PRs".
    pr(10, 1, 102, 11, 'api', 79, 'deployed', 1, 'merged', 30 * HOUR, {
      costUsd: 1.1,
      tokensIn: 580_000,
      tokensOut: 30_000,
      failures: 0,
    }),
    pr(5, 2, 202, 10, 'site', 44, 'deploying', 1, 'merged', 3 * MIN, {
      costUsd: 0.92,
      tokensIn: 400_000,
      tokensOut: 22_000,
      failures: 0,
    }),
    pr(4, 1, 103, 9, 'web', 207, 'deployed', 2, 'merged', 3 * 24 * HOUR, {
      costUsd: 2.6,
      tokensIn: 1_400_000,
      tokensOut: 70_000,
      failures: 1,
    }),
    pr(3, 1, 103, 9, 'api', 80, 'reverted', 1, 'reverted', 3 * 24 * HOUR + HOUR, {
      costUsd: 1.4,
      tokensIn: 700_000,
      tokensOut: 40_000,
      failures: 0,
    }),
    pr(2, 3, 301, null, 'terraform', 19, 'escalated', 5, 'escalated', 5 * HOUR, {
      costUsd: 6.85,
      tokensIn: 3_900_000,
      tokensOut: 180_000,
      failures: 4,
    }),
    pr(1, 2, 202, null, 'site', 41, 'merge', 1, null, 1 * MIN, {
      costUsd: 0.4,
      tokensIn: 150_000,
      tokensOut: 9_000,
      failures: 0,
    }),
  ];

  return {
    projects,
    tree,
    questions,
    pullRequests,
    requests,
    // What the finished list's View button shows: compacted transcripts of a few past sessions.
    transcripts: {
      // The oldest imported conversation and the ended runner session.
      103: {
        createdAt: at(3 * 24 * HOUR + 5 * MIN),
        text: [
          'Session 103 "Order export CSV" (branch loop/order-export, ended)',
          '',
          'User: Admins keep asking for a CSV of orders.',
          'Agent: I added /exports/orders.csv with a date-range filter, streaming one row at a time.',
          'User: Can it run without blocking the request?',
          'Agent: It is now a background job; the link sends an email when the file is ready.',
        ].join('\n\n'),
      },
      450: {
        createdAt: at(23 * 26 * HOUR + 38 * MIN),
        text: [
          'Session 450 "Tailor the resume for a staff engineer role" (branch "", ended)',
          '',
          'User: Tailor my resume for the staff engineer role at Acme.',
          'Agent: I rewrote the summary and the two most relevant role bullets to match the posting.',
          'User: Also mention the migration you led at Globex.',
          'Agent: Added a line about the 2019 Postgres migration, with the 4x throughput number.',
        ].join('\n\n'),
      },
    },
    usage: {
      capturedAt: at(2 * MIN),
      fiveHour: { usedPercentage: 38, resetsAt: at(-(2 * HOUR + 14 * MIN)) },
      sevenDay: { usedPercentage: 64, resetsAt: at(-(3 * 24 * HOUR + 5 * HOUR)) },
    },
    settings: {
      sessionModel: 'opus',
      fallbackModel: 'opencode/glm-5.3-flash-free',
      telegramAllowlist: [184_220_917, 902_118_334],
      claudeEnabled: true,
      opencodeEnabled: true,
      opencodeBackupModels: ['opencode/big-pickle'],
      dashboardLayout: {},
    },
    // Demo stages: the built-in pipeline, with sample prompts (the server serves the real files).
    pipeline: {
      pipeline: { checks: ['tests', 'review', 'qa'], deploy: true, guardian: true },
      stages: [
        stage('tests', 'Tests', 'Tests', 'shell', 'always', 'Run the tests that cover the changed files.'),
        stage(
          'review',
          'Code review',
          'CR',
          'read',
          'always',
          'Review for bugs, gaps and security problems.',
        ),
        stage('qa', 'Manual QA', 'QA', 'browser', 'ui-changes', 'Check the changed pages in a browser.'),
        // A custom stage file that is not in the pipeline: the editor shows it faded, to add.
        {
          ...stage('security', 'Security review', 'Security', 'read', 'always', 'Look for leaked secrets.'),
          icon: 'shield',
          builtin: false,
        },
      ],
      // Sample values; a real server sends its own lists.
      choices: {
        icons: [
          'tests',
          'review',
          'qa',
          'shield',
          'lock',
          'bug',
          'book',
          'gauge',
          'globe',
          'sparkle',
          'check',
        ],
        access: ['read', 'shell', 'browser'],
        runs: [
          'always',
          'code-changes',
          'ui-changes',
          'server-changes',
          'test-changes',
          'docs-changes',
          'dependency-changes',
          'database-changes',
          'infra-changes',
        ],
        // The server's RESERVED_STAGE_IDS (http-backend.test.ts checks they match).
        reserved: [
          'check',
          'awaiting_approval',
          'merge',
          'deploying',
          'deployed',
          'reverted',
          'escalated',
          'merged',
          'closed',
          'session',
          'builder',
          'approval',
          'deploy',
          'guardian',
          'end',
          'conflict',
          'ci',
          'pipeline',
        ],
      },
    },
  };
}

function stage(
  id: string,
  title: string,
  label: string,
  access: string,
  runs: string,
  prompt: string,
): Stage {
  return { id, title, label, icon: id, access, runs, prompt, builtin: true, overridden: false };
}

function project(
  id: number,
  name: string,
  repos: string[],
  flags: { autoMerge: boolean; markedForDirectInput: boolean; permissionMode?: string },
  createdAt: string,
): Project {
  return {
    id,
    name,
    kind: 'git',
    folderPath: null,
    repos: repos.map((r) => ({ name: r })),
    autoMerge: flags.autoMerge,
    markedForDirectInput: flags.markedForDirectInput,
    permissionMode: flags.permissionMode ?? 'auto',
    createdAt,
  };
}

function session(
  id: number,
  projectId: number,
  title: string,
  status: string,
  pauseReason: string | null,
  provider: string,
  model: string,
  createdAt: string,
  extra: Partial<TreeSession> & { subagents: Subagent[]; branch: string },
): TreeSession {
  return {
    id,
    projectId,
    title,
    status,
    pauseReason: status === 'paused' ? pauseReason : null,
    provider,
    model,
    effort: 'high',
    source: 'runner',
    createdAt,
    endedAt: null,
    pendingQuestions: 0,
    ...extra,
  };
}

function request(
  id: number,
  projectId: number | null,
  sessionId: number | null,
  text: string,
  source: string,
  createdAt: string,
): TaskRequest {
  return { id, projectId, sessionId, targetSessionId: null, text, source, createdAt };
}

/**
 * The editor's one example: the shop project with Search relevance, a live session that shows every
 * part of a row the layout can hide (run time, a subagent, PR cost, an earlier PR), and a finished one.
 */
export function editorExample(now: Date): Pick<DemoData, 'tree' | 'pullRequests' | 'questions' | 'usage'> {
  const { tree, pullRequests, questions, usage } = demoData(now);
  const shown = new Set([102, 103]);
  return {
    tree: tree
      .filter((p) => p.name === 'shop')
      .map((p) => ({ ...p, sessions: p.sessions.filter((s) => shown.has(s.id)) })),
    pullRequests: pullRequests.filter((pr) => pr.sessionId === 102),
    questions,
    usage,
  };
}
