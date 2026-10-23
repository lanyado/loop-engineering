import type { Repo } from '@loop-engineering/core';
import { CommandError, runCommand, runOk, type Runner } from '@loop-engineering/runner';
import {
  type CheckBucket,
  type Deployments,
  type DeployStatus,
  type GhCheck,
  type GhComment,
  type GhPr,
  type GitHub,
  type RepoRef,
} from './ports.js';

/** "owner/name" from a GitHub remote (ssh or https); any other remote is used as is. */
export function repoRef(repo: Repo): RepoRef {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo.remote);
  return { slug: match ? `${match[1]}/${match[2]}` : repo.remote, path: repo.path };
}

const PR_FIELDS =
  'number,url,title,body,state,headRefName,headRefOid,baseRefName,mergeable,mergeCommit,isCrossRepository';

interface RawPr {
  number: number;
  url: string;
  title?: string;
  body?: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  baseRefName?: string;
  mergeable?: string;
  mergeCommit?: { oid?: string } | null;
  isCrossRepository?: boolean;
}

function toPr(r: RawPr): GhPr {
  const state = r.state === 'MERGED' || r.state === 'CLOSED' ? r.state : 'OPEN';
  const mergeable = r.mergeable === 'MERGEABLE' || r.mergeable === 'CONFLICTING' ? r.mergeable : 'UNKNOWN';
  return {
    number: r.number,
    url: r.url,
    title: r.title ?? '',
    body: r.body ?? '',
    state,
    headRefName: r.headRefName,
    headRefOid: r.headRefOid,
    baseRefName: r.baseRefName ?? 'main',
    mergeable,
    mergeCommitSha: r.mergeCommit?.oid ?? null,
    // Unknown counts as a fork: the loop then refuses the PR rather than trusting it.
    isCrossRepository: r.isCrossRepository !== false,
  };
}

const BUCKETS: readonly string[] = ['pass', 'fail', 'pending', 'skipping', 'cancel'];

export interface GhOptions {
  /** Default "gh". */
  bin?: string;
  /** Extra environment (e.g. PATH with fake binaries in tests). */
  env?: Record<string, string | undefined>;
  run?: Runner;
}

/** GitHub through the gh CLI, which holds the user's auth. Every call names the repo with -R. */
export class GhCli implements GitHub {
  private readonly bin: string;
  private readonly env?: Record<string, string | undefined>;
  private readonly run: Runner;

  constructor(options: GhOptions = {}) {
    this.bin = options.bin ?? 'gh';
    this.env = options.env;
    this.run = options.run ?? runCommand;
  }

  private gh(repo: RepoRef, args: string[], input?: string): Promise<string> {
    return runOk(this.run, this.bin, [...args, '-R', repo.slug], { cwd: repo.path, env: this.env, input });
  }

  /** `gh api` takes no -R; the slug is in the path. */
  private api(repo: RepoRef, args: string[]): Promise<string> {
    return runOk(this.run, this.bin, ['api', ...args], { cwd: repo.path, env: this.env });
  }

  async ping(): Promise<void> {
    await runOk(this.run, this.bin, ['api', 'rate_limit'], { env: this.env });
  }

  async findPrForBranch(repo: RepoRef, branch: string): Promise<GhPr | null> {
    const out = await this.gh(repo, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '10',
      '--json',
      PR_FIELDS,
    ]);
    const prs = (JSON.parse(out) as RawPr[]).map(toPr).sort((a, b) => b.number - a.number);
    return prs.find((p) => p.state === 'OPEN') ?? prs[0] ?? null;
  }

  async getPr(repo: RepoRef, number: number): Promise<GhPr> {
    return toPr(
      JSON.parse(await this.gh(repo, ['pr', 'view', String(number), '--json', PR_FIELDS])) as RawPr,
    );
  }

  diff(repo: RepoRef, number: number): Promise<string> {
    return this.gh(repo, ['pr', 'diff', String(number)]);
  }

  async listComments(repo: RepoRef, number: number): Promise<GhComment[]> {
    const view = JSON.parse(
      await this.gh(repo, ['pr', 'view', String(number), '--json', 'comments,reviews']),
    ) as {
      comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
      reviews?: { author?: { login?: string }; body?: string; submittedAt?: string }[];
    };
    const inline = JSON.parse(
      await this.api(repo, [`repos/${repo.slug}/pulls/${number}/comments?per_page=100`]),
    ) as {
      user?: { login?: string };
      body?: string;
      created_at?: string;
      path?: string;
      line?: number | null;
    }[];
    const all: GhComment[] = [
      ...(view.comments ?? []).map((c) => ({
        author: c.author?.login ?? '',
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
      })),
      ...(view.reviews ?? [])
        .filter((r) => r.body)
        .map((r) => ({ author: r.author?.login ?? '', body: r.body ?? '', createdAt: r.submittedAt ?? '' })),
      ...inline.map((c) => ({
        author: c.user?.login ?? '',
        body: c.body ?? '',
        createdAt: c.created_at ?? '',
        path: c.path ?? null,
        line: c.line ?? null,
      })),
    ];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async postComment(repo: RepoRef, number: number, body: string): Promise<void> {
    await this.gh(repo, ['pr', 'comment', String(number), '--body-file', '-'], body);
  }

  async checks(repo: RepoRef, number: number): Promise<GhCheck[]> {
    // gh exits non-zero while checks are pending (8) or failing (1) but still prints the JSON.
    const result = await this.run(
      this.bin,
      ['pr', 'checks', String(number), '--json', 'name,bucket,link', '-R', repo.slug],
      { cwd: repo.path, env: this.env },
    );
    const out = result.stdout.trim();
    if (!out.startsWith('[')) {
      if (/no checks reported/i.test(result.stderr + result.stdout)) return [];
      throw new CommandError(`${this.bin} pr checks ${number}`, result);
    }
    return (JSON.parse(out) as { name: string; bucket: string; link?: string }[]).map((c) => ({
      name: c.name,
      bucket: (BUCKETS.includes(c.bucket) ? c.bucket : 'pending') as CheckBucket,
      link: c.link,
    }));
  }

  async mergeSquash(repo: RepoRef, number: number, headSha: string): Promise<void> {
    await this.gh(repo, ['pr', 'merge', String(number), '--squash', '--match-head-commit', headSha]);
  }

  async closePr(repo: RepoRef, number: number, comment: string): Promise<void> {
    await this.gh(repo, ['pr', 'close', String(number), '--comment', comment]);
  }

  async createRevertPr(repo: RepoRef, number: number, text: { title: string; body: string }): Promise<GhPr> {
    const out = await this.gh(repo, [
      'pr',
      'revert',
      String(number),
      '--title',
      text.title,
      '--body',
      text.body,
    ]);
    const match = /\/pull\/(\d+)/.exec(out);
    if (!match?.[1]) throw new Error(`gh pr revert printed no PR URL: ${out.trim().slice(0, 200)}`);
    return this.getPr(repo, Number(match[1]));
  }
}

interface RawDeployment {
  id: number;
  environment?: string;
  created_at?: string;
}

interface RawDeploymentStatus {
  state: string;
  description?: string | null;
  log_url?: string | null;
  target_url?: string | null;
  environment_url?: string | null;
}

/** Normalized environment name: lower case, any dash between words as "-". */
const envName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\s*[–—-]\s*/g, ' - ')
    .trim();

/**
 * Environments that are this project's production: Vercel names them "Production" (one project on
 * the repo) or "Production – <project>" (several). Matched exactly, so another project's deploy of
 * the same commit never counts.
 */
export const productionEnvironments = (vercelProject: string) => [
  envName(`Production – ${vercelProject}`),
  envName('Production'),
];

/**
 * Vercel deploy status from GitHub deployment statuses. Vercel's GitHub integration creates a GitHub
 * deployment per commit and updates its status, so `gh api` (already authenticated) is enough: no
 * Vercel token, team id or extra CLI. Only the project's production environment counts (see
 * productionEnvironments). The newest deployment decides; one whose latest status is "inactive" was
 * superseded: it counts as success if it had succeeded, otherwise the next older one decides.
 */
export class GhDeployments implements Deployments {
  private readonly bin: string;
  private readonly env?: Record<string, string | undefined>;
  private readonly run: Runner;

  constructor(options: GhOptions = {}) {
    this.bin = options.bin ?? 'gh';
    this.env = options.env;
    this.run = options.run ?? runCommand;
  }

  private async api<T>(repo: RepoRef, path: string): Promise<T> {
    return JSON.parse(await runOk(this.run, this.bin, ['api', path], { cwd: repo.path, env: this.env })) as T;
  }

  async status(repo: RepoRef, sha: string, vercelProject: string): Promise<DeployStatus> {
    const all = await this.api<RawDeployment[]>(
      repo,
      `repos/${repo.slug}/deployments?sha=${sha}&per_page=30`,
    );
    const wanted = productionEnvironments(vercelProject);
    const ours = all.filter((d) => wanted.includes(envName(d.environment ?? '')));
    if (ours.length === 0) return { state: 'not_found' };
    for (const d of ours) {
      // Newest first.
      const statuses = await this.api<RawDeploymentStatus[]>(
        repo,
        `repos/${repo.slug}/deployments/${d.id}/statuses?per_page=10`,
      );
      const latest = statuses[0];
      const result = (state: DeployStatus['state'], s: RawDeploymentStatus | undefined): DeployStatus => ({
        state,
        url: s?.environment_url ?? s?.target_url ?? null,
        logUrl: s?.log_url ?? s?.target_url ?? null,
        description: s?.description ?? null,
        environment: d.environment ?? null,
      });
      if (!latest) return result('pending', undefined);
      if (latest.state === 'inactive') {
        const succeeded = statuses.find((s) => s.state === 'success');
        if (succeeded) return result('success', succeeded);
        continue;
      }
      if (latest.state === 'success') return result('success', latest);
      if (latest.state === 'failure' || latest.state === 'error') return result('failure', latest);
      return result('pending', latest);
    }
    return { state: 'pending' };
  }
}
