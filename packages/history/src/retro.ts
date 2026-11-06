import { PAUSE_REASONS, parsePauseLog, type PauseReason } from '@loop-engineering/core';
import type { RetroWindow } from './retro-window.js';

/*
 * `loop retro`: what the loop did in a window, from the database alone (SQL and code, no model, no
 * network). collectRetro reads; retro-render.ts writes the Markdown.
 */

/** The read-only slice of better-sqlite3 this needs: a Database opened with `readonly: true` fits. */
export interface RetroDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export interface RetroOptions {
  window: RetroWindow;
  /** Only this project; every project when omitted. */
  projectId?: number;
  /** For what is still open (a pause, a pending question): measured up to here. */
  now: Date;
}

/** A PR (with its link), a session, a question or a request the numbers come from. */
export interface Evidence {
  label: string;
  url?: string;
}

/** Of durations (ms) or of counts. */
export interface Stats {
  count: number;
  median: number | null;
  p90: number | null;
  max: number | null;
  total: number;
}

export interface Problem {
  title: string;
  count: number;
  evidence: Evidence[];
}

export interface ReasonGroup {
  /** One real example of the group (redaction happens when rendering). */
  example: string;
  count: number;
  /** Where it was seen: escalation, closed, guardian, loop error. */
  sources: string[];
  evidence: Evidence[];
}

export interface StageRow {
  stage: string;
  /** Failed verdicts that went back to the builder (the loop's "… failed" PR comments). */
  failures: number;
  /** Escalations because the stage's job itself kept failing (crash, bad verdict, timeout). */
  jobFailures: number;
  evidence: Evidence[];
  jobEvidence: Evidence[];
}

export type RequestOutcome = 'merged' | 'in_progress' | 'ended_without_merge' | 'no_session' | 'unrouted';

export interface UnfinishedRequest {
  id: number;
  source: string;
  outcome: RequestOutcome;
  sessionId: number | null;
  createdAt: string;
  text: string;
}

export interface LongWait {
  questionId: number;
  sessionId: number;
  origin: string;
  status: string;
  waitMs: number;
  text: string;
}

export interface LongPause {
  sessionId: number;
  reason: PauseReason;
  startedAt: string;
  ms: number;
  ongoing: boolean;
}

export interface RetroData {
  window: RetroWindow;
  generatedAt: string;
  project: { id: number; name: string } | null;
  sessions: {
    started: number;
    finished: number;
    /** Started before the window's end and not ended by then. */
    openAtEnd: number;
    byRigor: Record<string, number>;
    byProvider: Record<string, number>;
    /** Sessions started and ended in the window. */
    duration: Stats;
  };
  pauses: {
    /** From the pause log (pause-log.ts): every pause with its reason and length. */
    byReason: Record<PauseReason, { pauses: number; sessions: number; pausedMs: number }>;
    longest: LongPause[];
    /** The window has pause log entries at all (older databases have none). */
    logged: boolean;
    /** Older evidence, written before the pause log: counts of history entries. */
    usageLimit: Evidence[];
    usageLimitFallbacks: number;
    agentGone: Evidence[];
    /** Automatic resumes that relaunched the agent; failed tries are counted apart. */
    autoResumes: Evidence[];
    autoResumeFailed: Evidence[];
    autoResumeGaveUp: Evidence[];
    modelMoves: Evidence[];
  };
  prs: {
    opened: number;
    byOutcome: Record<string, number>;
    /** Merged in the window, whenever opened. */
    mergedInWindow: number;
    /** Fix rounds (round - 1) per PR opened in the window: 0, 1, 2, 3, 4+. */
    fixRounds: number[];
    fixRoundStats: Stats;
    mostRounds: { pr: Evidence; rounds: number; outcome: string }[];
    tookOver: Evidence[];
    /** Escalations nobody answered: the PR left the loop by itself (outcome "escalated" too). */
    leftLoop: Evidence[];
    returned: Evidence[];
    skippedChecks: Evidence[];
    /** Merged PRs reverted later (labelled with the revert PR). */
    reverted: Evidence[];
    /** The loop's own revert PRs, left out of every other PR number. */
    revertPrs: Evidence[];
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    openToMerge: Stats;
    requestToMerge: Stats;
    slowest: { pr: Evidence; ms: number }[];
  };
  stages: {
    rows: StageRow[];
    reviewsPosted: number;
    /** Review rounds followed by another round with no other check failing in them. */
    reviewSendBacks: number;
    /** Failures the loop counted that no stage comment explains (CI, mostly). */
    otherFailures: number;
    escalations: Evidence[];
  };
  reasons: ReasonGroup[];
  guardian: {
    runs: number;
    byStatus: Record<string, number>;
    critical: number;
    areas: { area: string; failed: number; errored: number; flaky: number }[];
  };
  questions: {
    asked: number;
    byOrigin: Record<string, number>;
    byStatus: Record<string, number>;
    byChannel: Record<string, number>;
    answeredWait: Stats;
    /** Questions nobody answered: the time until their default was taken. */
    defaultedWait: Stats;
    /** Who asked the questions nobody answered (a stall alarm is the loop's, "system"). */
    defaultedByOrigin: Record<string, number>;
    over1h: number;
    longest: LongWait[];
  };
  requests: {
    created: number;
    bySource: Record<string, number>;
    byOutcome: Record<RequestOutcome, number>;
    unfinished: UnfinishedRequest[];
  };
  problems: Problem[];
}

interface SessionRow {
  id: number;
  status: string;
  provider: string;
  rigor: string;
  created_at: string;
  ended_at: string | null;
}
interface DecisionRow {
  project_id: number;
  session_id: number | null;
  text: string;
  created_at: string;
}
interface PrRow {
  id: number;
  project_id: number;
  session_id: number | null;
  request_id: number | null;
  repo: string;
  number: number;
  url: string;
  stage: string;
  round: number;
  outcome: string | null;
  reverted_by_pr_id: number | null;
  created_at: string;
  updated_at: string;
  loop_state: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  failures: number;
}
interface RequestRow {
  id: number;
  project_id: number | null;
  session_id: number | null;
  parent_request_id: number | null;
  source: string;
  text: string;
  created_at: string;
}
interface QuestionRow {
  id: number;
  session_id: number;
  status: string;
  origin: string;
  answered_via: string | null;
  text: string;
  created_at: string;
  deadline: string;
  answered_at: string | null;
}
interface GuardianRow {
  id: number;
  pr_id: number | null;
  status: string;
  critical: number;
  areas: string;
}
interface LoopStateView {
  posted?: unknown;
  lastError?: unknown;
  deployFailure?: { summary?: unknown };
  heldFor?: unknown;
  revertOf?: unknown;
}

const HOUR_MS = 60 * 60 * 1000;
/** A relaunch passes through a pause for a moment (runner.relaunch): not a pause anyone saw. */
const MIN_PAUSE_MS = 60_000;
const EVIDENCE_MAX = 8;
const LIST_MAX = 10;

const ms = (iso: string) => Date.parse(iso);
const inWindow = (iso: string | null, w: RetroWindow) => iso !== null && iso >= w.since && iso < w.until;
const count = <T extends string>(values: T[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};
/** PR numbers are per repo, and two projects can have a repo of the same name. */
const prKey = (projectId: number, repo: string, n: number) => `${projectId}/${repo}#${n}`;
/** Code-unit order, the same on every machine (localeCompare depends on the locale). */
export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Nearest-rank median and 90th percentile. */
export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
  return {
    count: sorted.length,
    median: at(0.5),
    p90: at(0.9),
    max: sorted.at(-1) ?? null,
    total: sorted.reduce((a, b) => a + b, 0),
  };
}

/** The same failure seen twice with different numbers, links or hashes groups as one. */
export function reasonKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/** Each item once, in the order first seen. */
function distinct(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((e) => !seen.has(e.label) && seen.add(e.label));
}

// Decision texts other modules write (their wording is part of what this reads).
const MERGED = /^PR (\S+)#(\d+)(?: merged|: the human merged it)/;
const ESCALATED = /^PR (\S+)#(\d+) sent to the human: (.+?)\.?$/s;
const CLOSED = /^PR (\S+)#(\d+) closed: (.+?)\.?$/s;
const TOOK_OVER = /^PR (\S+)#(\d+): the human took over/;
const LEFT_LOOP = /^PR (\S+)#(\d+): nobody answered, so it left the loop/;
const RETURNED = /^PR (\S+)#(\d+) was returned to the loop/;
const SKIPPED = /^PR (\S+)#(\d+): the human skipped/;
const REVERTED = /^PR (\S+)#(\d+) reverted by #(\d+)/;
const JOB_FAILED = /^The (\S+) job for PR #\d+ failed/;
const POSTED = /^(?:(tests|qa|review|escalated)|check-(.+))-(\d+)-[0-9a-f]+$/;
const USAGE_LIMIT = /^Claude usage limit reached/;
const AGENT_GONE = /^(?:Agent gone:|The \S+ agent of (?:folder )?session \d+ is gone)/;
const MODEL_MOVED = /^Session \d+ moved from \S+ to \S+:/;
// The runner's automatic resume: "Auto-resume: try 1 of 3: relaunched …" or "… try 1 of 3 failed: …".
const AUTO_RESUME_FAILED = /^Auto-resume: try \d+ of \d+ failed/;
const AUTO_RESUMED = /^Auto-resume:(?! try \d+ of \d+ failed)/;

export function collectRetro(db: RetroDb, options: RetroOptions): RetroData {
  const w = options.window;
  const now = options.now.toISOString();
  const nowMs = options.now.getTime();
  const pid = options.projectId ?? null;
  // The router's reserved project holds routing chatter, not work: left out of every count but questions.
  const routerRow = db
    .prepare(
      `SELECT s.project_id AS id FROM settings st JOIN sessions s ON s.id = st.router_session_id WHERE st.id = 1`,
    )
    .all()[0] as { id: number } | undefined;
  const router = routerRow?.id ?? null;
  const scope = (col: string) =>
    `(@pid IS NULL OR ${col} = @pid) AND (@router IS NULL OR ${col} IS NULL OR ${col} <> @router)`;
  const params = { pid, router };
  const project =
    pid === null
      ? null
      : ((db.prepare('SELECT id, name FROM projects WHERE id = ?').all(pid)[0] as
          { id: number; name: string } | undefined) ?? { id: pid, name: `project ${pid}` });

  const sessions = db
    .prepare(
      `SELECT id, status, provider, rigor, created_at, ended_at FROM sessions
       WHERE source = 'runner' AND ${scope('project_id')} ORDER BY id`,
    )
    .all(params) as SessionRow[];
  const decisions = db
    .prepare(
      `SELECT project_id, session_id, text, created_at FROM history_entries
       WHERE kind = 'decision' AND ${scope('project_id')} ORDER BY created_at, id`,
    )
    .all(params) as DecisionRow[];
  const prs = db
    .prepare(
      `SELECT p.id, p.project_id, p.session_id, p.request_id, p.repo, p.number, p.url, p.stage, p.round, p.outcome, p.reverted_by_pr_id,
              p.created_at, p.updated_at, p.loop_state, COALESCE(m.cost_usd, 0) AS cost_usd,
              COALESCE(m.tokens_in, 0) AS tokens_in, COALESCE(m.tokens_out, 0) AS tokens_out,
              COALESCE(m.failures, 0) AS failures
       FROM pull_requests p LEFT JOIN loop_metrics m ON m.pr_id = p.id
       WHERE ${scope('p.project_id')} ORDER BY p.id`,
    )
    .all(params) as PrRow[];
  const requests = db
    .prepare(
      `SELECT id, project_id, session_id, parent_request_id, source, text, created_at FROM requests
       WHERE ${scope('project_id')} ORDER BY id`,
    )
    .all(params) as RequestRow[];
  const questions = db
    .prepare(
      `SELECT q.id, q.session_id, q.status, q.origin, q.answered_via, q.text, q.created_at, q.deadline,
              q.answered_at
       FROM questions q JOIN sessions s ON s.id = q.session_id
       WHERE q.created_at >= @since AND q.created_at < @until AND (@pid IS NULL OR s.project_id = @pid)
       ORDER BY q.id`,
    )
    .all({ pid, since: w.since, until: w.until }) as QuestionRow[];
  const guardian = db
    .prepare(
      `SELECT id, pr_id, status, critical, areas FROM guardian_runs
       WHERE created_at >= @since AND created_at < @until AND ${scope('project_id')} ORDER BY id`,
    )
    .all({ ...params, since: w.since, until: w.until }) as GuardianRow[];

  // A PR's label says as much as the report needs to tell PRs apart: "#12", "web#12" when it has
  // several repos, "shop/web#12" when it has several projects (evidence is listed once per label).
  const projectName = new Map(
    (db.prepare('SELECT id, name FROM projects').all() as { id: number; name: string }[]).map((p) => [
      p.id,
      p.name,
    ]),
  );
  const multiProject = new Set(prs.map((p) => p.project_id)).size > 1;
  const multiRepo = new Set(prs.map((p) => p.repo)).size > 1;
  const prLabel = (projectId: number, repo: string, n: number | string) =>
    multiProject
      ? `${projectName.get(projectId) ?? `project ${projectId}`}/${repo}#${n}`
      : multiRepo
        ? `${repo}#${n}`
        : `#${n}`;
  const prByKey = new Map(prs.map((p) => [prKey(p.project_id, p.repo, p.number), p]));
  const prById = new Map(prs.map((p) => [p.id, p]));
  const prEvidence = (p: PrRow): Evidence => ({ label: prLabel(p.project_id, p.repo, p.number), url: p.url });
  /** A PR a history entry names: its project is the entry's. */
  const prRef = (d: DecisionRow, repo: string, n: string): Evidence => {
    const p = prByKey.get(prKey(d.project_id, repo, Number(n)));
    return p ? prEvidence(p) : { label: prLabel(d.project_id, repo, n) };
  };
  const sessionRef = (id: number | null): Evidence => ({
    label: id === null ? 'no session' : `session ${id}`,
  });
  const windowDecisions = decisions.filter((d) => inWindow(d.created_at, w));
  const matching = (re: RegExp) => windowDecisions.filter((d) => re.test(d.text));
  const prRefs = (re: RegExp) =>
    matching(re).map((d) => {
      const m = re.exec(d.text)!;
      return prRef(d, m[1]!, m[2]!);
    });
  const sessionRefs = (re: RegExp) => matching(re).map((d) => sessionRef(d.session_id));

  // Sessions
  const started = sessions.filter((s) => inWindow(s.created_at, w));
  const finished = sessions.filter((s) => inWindow(s.ended_at, w));
  const openAtEnd = sessions.filter(
    (s) => s.created_at < w.until && (s.ended_at === null || s.ended_at >= w.until),
  );
  const sessionDurations = started
    .filter((s) => inWindow(s.ended_at, w))
    .map((s) => ms(s.ended_at!) - ms(s.created_at));

  // Pauses, from the pause log: an interval runs from "paused" to the next entry of that session
  // (a resume or a new reason), else to its end, else to now; only the part inside the window counts.
  const endOf = new Map(sessions.map((s) => [s.id, s.ended_at]));
  const open = new Map<number, { reason: PauseReason; at: string }>();
  const intervals: { sessionId: number; reason: PauseReason; from: string; to: string; ongoing: boolean }[] =
    [];
  // Every entry up to now, not just the window: a pause that ends after the window still has its real end.
  for (const d of decisions) {
    const e = parsePauseLog(d.text);
    if (!e) continue;
    const prev = open.get(e.sessionId);
    if (prev)
      intervals.push({
        sessionId: e.sessionId,
        reason: prev.reason,
        from: prev.at,
        to: d.created_at,
        ongoing: false,
      });
    open.delete(e.sessionId);
    if (e.kind === 'paused') open.set(e.sessionId, { reason: e.reason, at: d.created_at });
  }
  for (const [sessionId, p] of open) {
    const ended = endOf.get(sessionId) ?? null;
    intervals.push({ sessionId, reason: p.reason, from: p.at, to: ended ?? now, ongoing: ended === null });
  }
  const windowEnd = w.until < now ? w.until : now;
  const byReason = Object.fromEntries(
    PAUSE_REASONS.map((r) => [r, { pauses: 0, sessions: 0, pausedMs: 0 }]),
  ) as RetroData['pauses']['byReason'];
  const pausedSessions = new Map<PauseReason, Set<number>>(PAUSE_REASONS.map((r) => [r, new Set()]));
  const longest: LongPause[] = [];
  for (const i of intervals) {
    if (ms(i.to) - ms(i.from) < MIN_PAUSE_MS) continue;
    const from = i.from > w.since ? i.from : w.since;
    const to = i.to < windowEnd ? i.to : windowEnd;
    if (to <= from) continue;
    const r = byReason[i.reason];
    if (inWindow(i.from, w)) r.pauses++;
    r.pausedMs += ms(to) - ms(from);
    pausedSessions.get(i.reason)!.add(i.sessionId);
    longest.push({
      sessionId: i.sessionId,
      reason: i.reason,
      startedAt: i.from,
      ms: ms(i.to) - ms(i.from),
      ongoing: i.ongoing,
    });
  }
  for (const r of PAUSE_REASONS) byReason[r].sessions = pausedSessions.get(r)!.size;
  longest.sort((a, b) => b.ms - a.ms || a.sessionId - b.sessionId);

  // PRs. The loop's own revert PRs are reported apart, not as work. The original names its revert
  // (reverted_by_pr_id); the revert's loopState.revertOf (the original's row id) is cleared once it
  // merges, so it only helps while the revert is in flight.
  const revertedBy = new Map(
    prs.flatMap((p) => (p.reverted_by_pr_id === null ? [] : [[p.reverted_by_pr_id, p] as const])),
  );
  const originalOf = (p: PrRow): PrRow | undefined => {
    const of = parseState(p.loop_state).revertOf;
    return revertedBy.get(p.id) ?? (typeof of === 'number' ? prById.get(of) : undefined);
  };
  const isRevertPr = (p: PrRow) => revertedBy.has(p.id) || parseState(p.loop_state).revertOf !== undefined;
  const opened = prs.filter((p) => inWindow(p.created_at, w) && !isRevertPr(p));
  const mergedAt = new Map<string, string>();
  for (const d of decisions) {
    const m = MERGED.exec(d.text);
    const key = m && prKey(d.project_id, m[1]!, Number(m[2]));
    if (key && !mergedAt.has(key)) mergedAt.set(key, d.created_at);
  }
  /** When it merged: a PR reverted later merged too. */
  const mergeTime = (p: PrRow) => {
    const logged = mergedAt.get(prKey(p.project_id, p.repo, p.number));
    if (p.outcome === 'merged') return logged ?? p.updated_at;
    return p.outcome === 'reverted' ? (logged ?? null) : null;
  };
  // outcome "escalated" is set when the human takes a PR over, and when an escalation nobody answered
  // lets it leave the loop: the newest of those history entries says which. A PR waiting on the human
  // has outcome null at stage "escalated".
  const lastExit = new Map<string, 'taken over' | 'left the loop (nobody answered)'>();
  for (const d of decisions) {
    const took = TOOK_OVER.exec(d.text);
    const left = took ? null : LEFT_LOOP.exec(d.text);
    const m = took ?? left;
    if (m)
      lastExit.set(
        prKey(d.project_id, m[1]!, Number(m[2])),
        took ? 'taken over' : 'left the loop (nobody answered)',
      );
  }
  const outcomeOf = (p: PrRow) =>
    p.outcome === 'escalated'
      ? (lastExit.get(prKey(p.project_id, p.repo, p.number)) ?? 'taken over')
      : (p.outcome ?? (p.stage === 'escalated' ? 'escalated' : p.stage === 'reverted' ? 'reverted' : 'open'));
  const rounds = (p: PrRow) => Math.max(0, p.round - 1);
  const fixRounds = [0, 0, 0, 0, 0];
  for (const p of opened) fixRounds[Math.min(4, rounds(p))]!++;
  const requestById = new Map(requests.map((r) => [r.id, r]));
  const openToMerge: number[] = [];
  const requestToMerge: number[] = [];
  const slowest: { pr: Evidence; ms: number }[] = [];
  for (const p of opened) {
    const at = mergeTime(p);
    if (!at) continue;
    openToMerge.push(ms(at) - ms(p.created_at));
    const request = p.request_id === null ? undefined : requestById.get(p.request_id);
    if (request) {
      const took = ms(at) - ms(request.created_at);
      requestToMerge.push(took);
      slowest.push({ pr: prEvidence(p), ms: took });
    }
  }
  slowest.sort((a, b) => b.ms - a.ms);

  // Stages: the loop's PR comments say which check failed in which round (loopState.posted).
  const stageRows = new Map<string, StageRow>();
  const row = (stage: string) => {
    let r = stageRows.get(stage);
    if (!r) stageRows.set(stage, (r = { stage, failures: 0, jobFailures: 0, evidence: [], jobEvidence: [] }));
    return r;
  };
  let reviewsPosted = 0;
  let reviewSendBacks = 0;
  let otherFailures = 0;
  const reasons = new Map<string, ReasonGroup>();
  const addReason = (text: string, source: string, evidence: Evidence | null) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const key = reasonKey(clean);
    let g = reasons.get(key);
    if (!g) reasons.set(key, (g = { example: clean, count: 0, sources: [], evidence: [] }));
    g.count++;
    if (!g.sources.includes(source)) g.sources.push(source);
    if (evidence) g.evidence.push(evidence);
  };
  for (const p of opened) {
    const state = parseState(p.loop_state);
    const posted = Array.isArray(state.posted)
      ? state.posted.filter((k): k is string => typeof k === 'string')
      : [];
    const failedRounds = new Set<number>();
    const reviewRounds = new Set<number>();
    let explained = 0;
    for (const key of posted) {
      const m = POSTED.exec(key);
      if (!m) continue;
      const stage = m[2] ?? m[1]!;
      const round = Number(m[3]);
      if (stage === 'escalated') continue;
      if (stage === 'review') {
        reviewsPosted++;
        reviewRounds.add(round);
        continue;
      }
      const r = row(stage);
      r.failures++;
      r.evidence.push(prEvidence(p));
      failedRounds.add(round);
      explained++;
    }
    for (const r of reviewRounds) if (r < p.round && !failedRounds.has(r)) reviewSendBacks++;
    otherFailures += Math.max(0, p.failures - explained);
    if (typeof state.lastError === 'string') addReason(state.lastError, 'loop error', prEvidence(p));
    if (typeof state.heldFor === 'string') addReason(state.heldFor, 'held', prEvidence(p));
    if (typeof state.deployFailure?.summary === 'string')
      addReason(`deploy failed: ${state.deployFailure.summary}`, 'deploy', prEvidence(p));
  }
  const escalations = matching(ESCALATED);
  for (const d of escalations) {
    const m = ESCALATED.exec(d.text)!;
    const ev = prRef(d, m[1]!, m[2]!);
    addReason(m[3]!, 'escalation', ev);
    const job = JOB_FAILED.exec(m[3]!);
    if (job) {
      // A custom check's job is "check-<id>"; its failure comments are keyed by <id>.
      const r = row(job[1]!.replace(/^check-/, ''));
      r.jobFailures++;
      r.jobEvidence.push(ev);
    }
  }
  for (const d of matching(CLOSED)) {
    const m = CLOSED.exec(d.text)!;
    addReason(`closed: ${m[3]!}`, 'closed', prRef(d, m[1]!, m[2]!));
  }

  // Production Guardian
  const areas = new Map<string, { area: string; failed: number; errored: number; flaky: number }>();
  for (const g of guardian) {
    const pr = g.pr_id === null ? undefined : prById.get(g.pr_id);
    for (const a of parseAreas(g.areas)) {
      let t = areas.get(a.area);
      if (!t) areas.set(a.area, (t = { area: a.area, failed: 0, errored: 0, flaky: 0 }));
      if (a.flaky) t.flaky++;
      if (a.passed) continue;
      if (a.errored) t.errored++;
      else t.failed++;
      for (const f of a.failures)
        addReason(`${a.area}: ${f}`, 'guardian', pr ? prEvidence(pr) : { label: `guardian run ${g.id}` });
    }
  }

  // Questions to humans
  const waits: number[] = [];
  const defaulted: number[] = [];
  const longWaits: LongWait[] = [];
  for (const q of questions) {
    let wait: number | null = null;
    if (q.status === 'answered' && q.answered_at) waits.push((wait = ms(q.answered_at) - ms(q.created_at)));
    else if (q.status === 'defaulted')
      defaulted.push((wait = ms(q.answered_at ?? q.deadline) - ms(q.created_at)));
    else if (q.status === 'pending') wait = nowMs - ms(q.created_at);
    if (wait !== null)
      longWaits.push({
        questionId: q.id,
        sessionId: q.session_id,
        origin: q.origin,
        status: q.status,
        waitMs: wait,
        text: q.text,
      });
  }
  longWaits.sort((a, b) => b.waitMs - a.waitMs || a.questionId - b.questionId);

  // Requests: done when a PR of theirs (or of a part of them) merged, or their session merged a PR after them.
  const childrenOf = new Map<number, number[]>();
  for (const r of requests)
    if (r.parent_request_id !== null)
      childrenOf.set(r.parent_request_id, [...(childrenOf.get(r.parent_request_id) ?? []), r.id]);
  const sessionStatus = new Map(sessions.map((s) => [s.id, s.status]));
  const outcome = (r: RequestRow): RequestOutcome => {
    if (r.project_id === null) return 'unrouted';
    const family = new Set([r.id, ...(childrenOf.get(r.id) ?? [])]);
    const merged = prs.some(
      (p) =>
        p.outcome === 'merged' &&
        ((p.request_id !== null && family.has(p.request_id)) ||
          (r.session_id !== null && p.session_id === r.session_id && (mergeTime(p) ?? '') >= r.created_at)),
    );
    if (merged) return 'merged';
    if (r.session_id === null) return 'no_session';
    return sessionStatus.get(r.session_id) === 'ended' ? 'ended_without_merge' : 'in_progress';
  };
  const windowRequests = requests.filter((r) => inWindow(r.created_at, w));
  const outcomes = windowRequests.map((r) => ({ r, o: outcome(r) }));
  const byOutcome: Record<RequestOutcome, number> = {
    merged: 0,
    in_progress: 0,
    ended_without_merge: 0,
    no_session: 0,
    unrouted: 0,
  };
  for (const { o } of outcomes) byOutcome[o]++;
  const unfinished = outcomes
    .filter(({ o }) => o !== 'merged')
    .map(({ r, o }) => ({
      id: r.id,
      source: r.source,
      outcome: o,
      sessionId: r.session_id,
      createdAt: r.created_at,
      text: r.text,
    }));

  const data: RetroData = {
    window: w,
    generatedAt: now,
    project,
    sessions: {
      started: started.length,
      finished: finished.length,
      openAtEnd: openAtEnd.length,
      byRigor: count(started.map((s) => s.rigor)),
      byProvider: count(started.map((s) => s.provider)),
      duration: stats(sessionDurations),
    },
    pauses: {
      byReason,
      longest: longest.slice(0, LIST_MAX),
      logged: intervals.some((i) => i.from < windowEnd && i.to > w.since),
      usageLimit: sessionRefs(USAGE_LIMIT),
      usageLimitFallbacks: matching(USAGE_LIMIT).filter((d) => /switched from claude\//.test(d.text)).length,
      agentGone: sessionRefs(AGENT_GONE),
      // Written by the runner's automatic resume of sessions whose agent went away.
      autoResumes: sessionRefs(AUTO_RESUMED),
      autoResumeFailed: sessionRefs(AUTO_RESUME_FAILED),
      autoResumeGaveUp: sessionRefs(/^Auto-resume stopped/),
      modelMoves: sessionRefs(MODEL_MOVED),
    },
    prs: {
      opened: opened.length,
      byOutcome: count(opened.map(outcomeOf)),
      mergedInWindow: prs.filter((p) => !isRevertPr(p) && inWindow(mergeTime(p), w)).length,
      fixRounds,
      fixRoundStats: stats(opened.map(rounds)),
      mostRounds: [...opened]
        .filter((p) => rounds(p) > 0)
        .sort((a, b) => rounds(b) - rounds(a) || a.id - b.id)
        .slice(0, LIST_MAX)
        .map((p) => ({ pr: prEvidence(p), rounds: rounds(p), outcome: outcomeOf(p) })),
      tookOver: prRefs(TOOK_OVER),
      leftLoop: prRefs(LEFT_LOOP),
      returned: prRefs(RETURNED),
      skippedChecks: prRefs(SKIPPED),
      reverted: matching(REVERTED).map((d) => {
        const m = REVERTED.exec(d.text)!;
        const pr = prRef(d, m[1]!, m[2]!);
        return { ...pr, label: `${pr.label} (reverted by #${m[3]!})` };
      }),
      revertPrs: prs
        .filter((p) => inWindow(p.created_at, w) && isRevertPr(p))
        .map((p) => {
          const original = originalOf(p);
          const of = original ? prEvidence(original).label : 'an unknown PR';
          return { ...prEvidence(p), label: `${prEvidence(p).label} (revert of ${of})` };
        }),
      costUsd: opened.reduce((a, p) => a + p.cost_usd, 0),
      tokensIn: opened.reduce((a, p) => a + p.tokens_in, 0),
      tokensOut: opened.reduce((a, p) => a + p.tokens_out, 0),
      openToMerge: stats(openToMerge),
      requestToMerge: stats(requestToMerge),
      slowest: slowest.slice(0, 5),
    },
    stages: {
      rows: [...stageRows.values()].sort(
        (a, b) => b.failures + b.jobFailures - (a.failures + a.jobFailures) || byText(a.stage, b.stage),
      ),
      reviewsPosted,
      reviewSendBacks,
      otherFailures,
      escalations: escalations.map((d) => {
        const m = ESCALATED.exec(d.text)!;
        return prRef(d, m[1]!, m[2]!);
      }),
    },
    reasons: [...reasons.values()]
      .sort((a, b) => b.count - a.count || byText(reasonKey(a.example), reasonKey(b.example)))
      .slice(0, LIST_MAX),
    guardian: {
      runs: guardian.length,
      byStatus: count(guardian.map((g) => g.status)),
      critical: guardian.filter((g) => g.critical === 1).length,
      areas: [...areas.values()].sort(
        (a, b) => b.failed + b.errored - (a.failed + a.errored) || byText(a.area, b.area),
      ),
    },
    questions: {
      asked: questions.length,
      byOrigin: count(questions.map((q) => q.origin)),
      byStatus: count(questions.map((q) => q.status)),
      // "timeout" is no answer: those are the defaulted ones.
      byChannel: count(
        questions.flatMap((q) => (q.answered_via && q.answered_via !== 'timeout' ? [q.answered_via] : [])),
      ),
      answeredWait: stats(waits),
      defaultedWait: stats(defaulted),
      defaultedByOrigin: count(questions.filter((q) => q.status === 'defaulted').map((q) => q.origin)),
      over1h: longWaits.filter((q) => q.status === 'answered' && q.waitMs > HOUR_MS).length,
      longest: longWaits.slice(0, 5),
    },
    requests: {
      created: windowRequests.length,
      bySource: count(windowRequests.map((r) => r.source)),
      byOutcome,
      unfinished,
    },
    problems: [],
  };
  data.problems = topProblems(data, {
    stopped: sessionRefs(/^Session \d+ stopped after PR #\d+; worktrees kept/),
    idle: sessionRefs(/^Idle watchdog nudge/),
    permission: sessionRefs(/^Permission watchdog: refused/),
    guardianFailed: guardian
      .filter((g) => g.status === 'failed' || g.status === 'error')
      .map((g) => {
        const pr = g.pr_id === null ? undefined : prById.get(g.pr_id);
        return pr ? prEvidence(pr) : { label: `guardian run ${g.id}` };
      }),
    defaulted: questions.filter((q) => q.status === 'defaulted').map((q) => ({ label: `question ${q.id}` })),
    slowAnswers: longWaits
      .filter((q) => q.status === 'answered' && q.waitMs > HOUR_MS)
      .map((q) => ({ label: `question ${q.questionId}` })),
    manyRounds: opened.filter((p) => rounds(p) >= 3).map(prEvidence),
  });
  return data;
}

interface ProblemInputs {
  stopped: Evidence[];
  idle: Evidence[];
  permission: Evidence[];
  guardianFailed: Evidence[];
  defaulted: Evidence[];
  slowAnswers: Evidence[];
  manyRounds: Evidence[];
}

/** Every problem with evidence, the most frequent first (ties by title), at most LIST_MAX. */
function topProblems(d: RetroData, x: ProblemInputs): Problem[] {
  const problems: Problem[] = [];
  const add = (title: string, evidence: Evidence[], n = evidence.length) => {
    if (n > 0) problems.push({ title, count: n, evidence: distinct(evidence) });
  };
  for (const r of d.stages.rows) {
    add(`${r.stage} failed and sent the PR back`, r.evidence, r.failures);
    add(`the ${r.stage} job itself kept failing`, r.jobEvidence, r.jobFailures);
  }
  add('PRs needed 3 or more fix rounds', x.manyRounds);
  add('PRs sent to the human (escalated)', d.stages.escalations);
  add('the human took a PR over', d.prs.tookOver);
  add('PRs that left the loop because nobody answered', d.prs.leftLoop);
  add('deploys reverted', d.prs.reverted);
  add('Production Guardian failed or errored after a deploy', x.guardianFailed);
  add('Claude usage limit reached', d.pauses.usageLimit);
  add('an agent exited or its window closed', d.pauses.agentGone);
  add('auto-resume gave up on a session', d.pauses.autoResumeGaveUp);
  add('automatic resume tries that failed', d.pauses.autoResumeFailed);
  add('a session moved to another model', d.pauses.modelMoves);
  add('questions nobody answered (the default was taken)', x.defaulted);
  add('answers that took over an hour', x.slowAnswers);
  const unfinished = d.requests.unfinished.filter((r) => r.outcome !== 'in_progress');
  add(
    'requests that never finished',
    unfinished.map((r) => ({ label: `request ${r.id}` })),
  );
  add('sessions stopped with uncommitted changes', x.stopped);
  add('idle watchdog nudges', x.idle);
  add('permission prompts refused by the watchdog', x.permission);
  for (const g of d.reasons) if (g.count >= 2) add(`recurring: ${g.example}`, g.evidence, g.count);
  return problems
    .sort((a, b) => b.count - a.count || byText(a.title, b.title))
    .slice(0, LIST_MAX)
    .map((p) => ({ ...p, evidence: p.evidence.slice(0, EVIDENCE_MAX) }));
}

function parseState(json: string): LoopStateView {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

interface AreaResult {
  area: string;
  passed: boolean;
  errored: boolean;
  flaky: boolean;
  failures: string[];
}

function parseAreas(json: string): AreaResult[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.flatMap((a: unknown): AreaResult[] => {
    if (!a || typeof a !== 'object') return [];
    const o = a as Record<string, unknown>;
    if (typeof o.area !== 'string') return [];
    return [
      {
        area: o.area,
        passed: o.passed === true,
        errored: o.errored === true,
        flaky: o.flaky === true,
        failures: Array.isArray(o.failures)
          ? o.failures.filter((f): f is string => typeof f === 'string')
          : [],
      },
    ];
  });
}
