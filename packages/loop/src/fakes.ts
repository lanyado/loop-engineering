// In-memory fakes for every port. Exported so other packages' tests (the server module) can use them.
import type { EnvFile, Repo } from '@loop-engineering/core';
import type { LocalBranchResult, PushResult, RemoteBranchResult } from './ports.js';
import {
  type AgentJob,
  type AgentJobResult,
  type AgentLauncher,
  type Deployments,
  type DeployStatus,
  type GhCheck,
  type GhComment,
  type GhPr,
  type GitHub,
  type JobKind,
  type RepoRef,
  type Workspace,
} from './ports.js';

interface FakePr extends GhPr {
  slug: string;
  comments: GhComment[];
  checks: GhCheck[];
}

let shaCounter = 0;
/** A new 40-hex fake commit id. */
export const fakeSha = () => (++shaCounter).toString(16).padStart(40, 'a');

export class FakeGitHub implements GitHub {
  readonly prs = new Map<string, FakePr>();
  readonly calls: string[] = [];
  /** mergeSquash throws this many times before it succeeds. */
  failMerges = 0;
  /** createRevertPr throws this many times before it succeeds. */
  failReverts = 0;
  /** While true every call fails like gh does without a connection (and ping fails too). */
  offline = false;
  private next = 1;

  private down = <T>(): Promise<T> =>
    Promise.reject(new Error('gh failed (1): error connecting to api.github.com'));

  ping(): Promise<void> {
    return this.offline ? this.down() : Promise.resolve();
  }

  private key = (slug: string, n: number) => `${slug}#${n}`;

  /** A PR the builder opened. */
  open(
    slug: string,
    init: { branch: string; title?: string; body?: string; base?: string; fork?: boolean },
  ): FakePr {
    const number = this.next++;
    const pr: FakePr = {
      slug,
      number,
      url: `https://github.com/${slug}/pull/${number}`,
      title: init.title ?? `PR ${number}`,
      body: init.body ?? '',
      state: 'OPEN',
      headRefName: init.branch,
      headRefOid: fakeSha(),
      baseRefName: init.base ?? 'main',
      mergeable: 'MERGEABLE',
      mergeCommitSha: null,
      isCrossRepository: init.fork ?? false,
      comments: [],
      checks: [],
    };
    this.prs.set(this.key(slug, number), pr);
    return pr;
  }

  /** The builder pushed a new commit. */
  push(slug: string, number: number): string {
    const pr = this.require(slug, number);
    pr.headRefOid = fakeSha();
    return pr.headRefOid;
  }

  pr(slug: string, number: number): FakePr {
    return this.require(slug, number);
  }

  private require(slug: string, number: number): FakePr {
    const pr = this.prs.get(this.key(slug, number));
    if (!pr) throw new Error(`no PR ${slug}#${number}`);
    return pr;
  }

  private copy(pr: FakePr): GhPr {
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
      mergeable: pr.mergeable,
      mergeCommitSha: pr.mergeCommitSha,
      isCrossRepository: pr.isCrossRepository,
    };
  }

  findPrForBranch(repo: RepoRef, branch: string): Promise<GhPr | null> {
    if (this.offline) return this.down();
    this.calls.push(`find ${branch}`);
    const prs = [...this.prs.values()]
      .filter((p) => p.slug === repo.slug && p.headRefName === branch)
      .sort((a, b) => b.number - a.number);
    const pr = prs.find((p) => p.state === 'OPEN') ?? prs[0];
    return Promise.resolve(pr ? this.copy(pr) : null);
  }

  getPr(repo: RepoRef, number: number): Promise<GhPr> {
    if (this.offline) return this.down();
    return Promise.resolve(this.copy(this.require(repo.slug, number)));
  }

  /** Files every PR's diff changes. */
  diffFiles = ['app.ts'];

  diff(repo: RepoRef, number: number): Promise<string> {
    if (this.offline) return this.down();
    const pr = this.require(repo.slug, number);
    return Promise.resolve(
      this.diffFiles.map((f) => `diff --git a/${f} b/${f}\n+// ${pr.headRefOid}\n`).join(''),
    );
  }

  listComments(repo: RepoRef, number: number): Promise<GhComment[]> {
    if (this.offline) return this.down();
    return Promise.resolve([...this.require(repo.slug, number).comments]);
  }

  postComment(repo: RepoRef, number: number, body: string): Promise<void> {
    if (this.offline) return this.down();
    this.calls.push(`comment #${number}`);
    this.require(repo.slug, number).comments.push({
      author: 'loop',
      body,
      createdAt: new Date(0).toISOString(),
    });
    return Promise.resolve();
  }

  checks(repo: RepoRef, number: number): Promise<GhCheck[]> {
    if (this.offline) return this.down();
    return Promise.resolve([...this.require(repo.slug, number).checks]);
  }

  mergeSquash(repo: RepoRef, number: number, headSha: string): Promise<void> {
    if (this.offline) return this.down();
    this.calls.push(`merge #${number}`);
    const pr = this.require(repo.slug, number);
    if (this.failMerges > 0) {
      this.failMerges--;
      return Promise.reject(new Error('GraphQL: Base branch was modified. Review and try the merge again.'));
    }
    if (pr.state !== 'OPEN') return Promise.reject(new Error(`PR #${number} is not open`));
    if (pr.headRefOid !== headSha) return Promise.reject(new Error('Head branch was modified'));
    pr.state = 'MERGED';
    pr.mergeCommitSha = fakeSha();
    return Promise.resolve();
  }

  closePr(repo: RepoRef, number: number): Promise<void> {
    if (this.offline) return this.down();
    this.calls.push(`close #${number}`);
    this.require(repo.slug, number).state = 'CLOSED';
    return Promise.resolve();
  }

  createRevertPr(repo: RepoRef, number: number, text: { title: string; body: string }): Promise<GhPr> {
    if (this.offline) return this.down();
    this.calls.push(`revert #${number}`);
    if (this.failReverts > 0) {
      this.failReverts--;
      return Promise.reject(new Error('could not revert: merge conflict'));
    }
    const pr = this.open(repo.slug, { branch: `revert-${number}`, title: text.title, body: text.body });
    return Promise.resolve(this.copy(pr));
  }
}

export type JobHandler = (job: AgentJob, signal: AbortSignal) => AgentJobResult | Promise<AgentJobResult>;

/** A job answer like the CLIs give: text ending in a ```json verdict block. */
export function verdictResult(verdict: unknown, usage: Partial<AgentJobResult> = {}): AgentJobResult {
  return {
    text: `Done.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``,
    costUsd: 0.1,
    tokensIn: 1000,
    tokensOut: 100,
    isError: false,
    ...usage,
  };
}

/** Answers each job kind from a queue of handlers (the last one repeats). Records every job. */
export class FakeAgentLauncher implements AgentLauncher {
  readonly jobs: AgentJob[] = [];
  private readonly queues = new Map<JobKind, JobHandler[]>();

  on(kind: JobKind, ...handlers: (JobHandler | AgentJobResult)[]): this {
    const list = this.queues.get(kind) ?? [];
    for (const h of handlers) list.push(typeof h === 'function' ? h : () => h);
    this.queues.set(kind, list);
    return this;
  }

  async run(job: AgentJob, signal: AbortSignal): Promise<AgentJobResult> {
    this.jobs.push(job);
    const list = this.queues.get(job.kind) ?? [];
    const handler = list.length > 1 ? list.shift() : list[0];
    if (!handler) throw new Error(`no fake answer for a ${job.kind} job`);
    return handler(job, signal);
  }

  kinds(): JobKind[] {
    return this.jobs.map((j) => j.kind);
  }
}

export class FakeDeployments implements Deployments {
  readonly statuses = new Map<string, DeployStatus>();
  readonly calls: string[] = [];

  set(sha: string, status: DeployStatus): void {
    this.statuses.set(sha, status);
  }

  status(_repo: RepoRef, sha: string, vercelProject: string): Promise<DeployStatus> {
    this.calls.push(`${vercelProject}@${sha}`);
    return Promise.resolve(this.statuses.get(sha) ?? { state: 'pending' });
  }
}

export class FakeWorkspace implements Workspace {
  readonly checkouts: { repo: string; branch: string; sha: string; path: string; envFiles: EnvFile[] }[] = [];
  readonly removed: string[] = [];
  readonly live = new Set<string>();
  /** Every branch delete the loop asked for, with its result. */
  readonly remoteDeletes: {
    repo: string;
    branch: string;
    expectedSha: string;
    result: RemoteBranchResult;
  }[] = [];
  readonly localDeletes: {
    repo: string;
    branch: string;
    mergedHeadSha: string;
    result: LocalBranchResult;
  }[] = [];
  readonly pushes: { repo: string; branch: string; baseSha: string }[] = [];
  /** What deleteRemoteBranch / deleteLocalBranch answer. */
  remoteResult: RemoteBranchResult = 'deleted';
  localResult: LocalBranchResult = 'deleted';
  /** Commits isAncestor denies ("not on the session's local branch"). */
  readonly foreign = new Set<string>();
  /** What commitAndPush returns for a checkout; default: nothing to push. */
  onCommit: (input: { path: string; branch: string; baseSha: string }) => PushResult = () => ({
    status: 'none',
  });

  checkout(input: {
    repo: Repo;
    branch: string;
    sha: string;
    name: string;
    envFiles: EnvFile[];
  }): Promise<string> {
    const path = `/jobs/${input.name}`;
    this.checkouts.push({
      repo: input.repo.name,
      branch: input.branch,
      sha: input.sha,
      path,
      envFiles: input.envFiles,
    });
    this.live.add(path);
    return Promise.resolve(path);
  }

  remove(_repo: Repo, path: string): Promise<void> {
    this.removed.push(path);
    this.live.delete(path);
    return Promise.resolve();
  }

  isAncestor(_repo: Repo, sha: string): Promise<boolean> {
    return Promise.resolve(!this.foreign.has(sha));
  }

  commitAndPush(
    repo: Repo,
    path: string,
    input: { branch: string; baseSha: string; message: string },
  ): Promise<PushResult> {
    const result = this.onCommit({ path, branch: input.branch, baseSha: input.baseSha });
    if (result.status === 'pushed')
      this.pushes.push({ repo: repo.name, branch: input.branch, baseSha: input.baseSha });
    return Promise.resolve(result);
  }

  deleteRemoteBranch(repo: Repo, branch: string, expectedSha: string): Promise<RemoteBranchResult> {
    this.remoteDeletes.push({ repo: repo.name, branch, expectedSha, result: this.remoteResult });
    return Promise.resolve(this.remoteResult);
  }

  deleteLocalBranch(repo: Repo, branch: string, mergedHeadSha: string): Promise<LocalBranchResult> {
    this.localDeletes.push({ repo: repo.name, branch, mergedHeadSha, result: this.localResult });
    return Promise.resolve(this.localResult);
  }
}
