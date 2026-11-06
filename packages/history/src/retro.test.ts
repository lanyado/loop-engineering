import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { FakeClock, openStore, type Store } from '@loop-engineering/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectRetro, reasonKey, stats, type RetroData } from './retro.js';
import {
  cleanText,
  formatDuration,
  renderRetro,
  RETRO_REQUEST_MAX,
  retroRequestText,
} from './retro-render.js';
import { describeWindow, previousMonth, retroFileName, windowFromFlags } from './retro-window.js';

const HOUR = 60 * 60 * 1000;
const OCTOBER = { since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z' };
const NOW = new Date('2026-11-01T06:00:00.000Z');

/**
 * A month of a made-up project "shop" (repo "web"), written through the store like the server does,
 * plus a little of a second project and of the months around it.
 */
function buildFixture(path: string): { shop: number; blog: number } {
  const clock = new FakeClock('2026-09-29T12:00:00.000Z');
  const store: Store = openStore({ path, clock });
  const at = (iso: string) => clock.set(`2026-${iso}:00.000Z`);
  const web = [
    { name: 'web', path: '/src/web', remote: 'git@example.com:shop/web.git', defaultBranch: 'main' },
  ];
  const shop = store.projects.create({ name: 'shop', repos: web }).id;
  const blog = store.projects.create({ name: 'blog' }).id;
  const note = (sessionId: number | null, text: string) =>
    store.history.add({ projectId: shop, sessionId, kind: 'decision', text });
  const pr = (number: number, sessionId: number, requestId: number | null) =>
    store.pullRequests.create({
      projectId: shop,
      repo: 'web',
      number,
      url: `https://github.example/shop/web/pull/${number}`,
      sessionId,
      requestId,
    }).id;
  const session = (title: string) =>
    store.sessions.create({ projectId: shop, title, model: 'opus', branch: title }).id;

  // Before the window: a PR that is not counted, and a session paused across midnight.
  const old = session('old');
  pr(13, old, null);
  store.sessions.update(old, { status: 'ended' });
  at('09-30T20:00');
  const s1 = session('s1');
  at('09-30T23:00');
  store.sessions.update(s1, { status: 'paused', pauseReason: 'manual' });
  at('10-01T02:00');
  store.sessions.update(s1, { status: 'active' });
  at('10-01T05:00');
  store.sessions.update(s1, { status: 'ended' });

  // A request merged after two fix rounds, with a usage-limit pause on the way.
  at('10-02T09:00');
  const s2 = session('s2');
  const reqA = store.requests.create({
    projectId: shop,
    sessionId: s2,
    text: 'Add a cart',
    source: 'email',
  }).id;
  at('10-02T10:00');
  const pr10 = pr(10, s2, reqA);
  store.pullRequests.update(pr10, {
    round: 3,
    outcome: 'merged',
    stage: 'deployed',
    loopState: { posted: ['tests-1-aaaaaaa', 'review-2-bbbbbbb', 'review-3-ccccccc'], done: true },
  });
  store.metrics.record(pr10, { costUsd: 2.5, tokensIn: 1000, tokensOut: 100, failures: 2 });
  const q1 = store.questions.create({
    sessionId: s2,
    text: 'Which color?',
    options: ['red', 'blue'],
    recommendedOption: 'red',
    timeoutMs: 24 * HOUR,
  });
  at('10-02T10:45');
  store.questions.answer(q1.id, 'blue', 'dashboard');
  at('10-02T11:00');
  note(
    s2,
    `Claude usage limit reached ("limit"). It resets soon, so session ${s2} stays paused (usage_limit) until Claude answers again.`,
  );
  store.sessions.update(s2, { status: 'paused', pauseReason: 'usage_limit' });
  at('10-02T12:30');
  store.sessions.update(s2, { status: 'active' });
  store.sessions.update(s2, { status: 'paused', pauseReason: 'agent_exited' }); // a relaunch: not counted
  clock.advance(5_000);
  store.sessions.update(s2, { status: 'active' });
  at('10-02T15:00');
  note(s2, 'PR web#10 merged (squash) as abc1234.');
  at('10-02T15:30');
  const g1 = store.guardianRuns.create({ projectId: shop, repo: 'web', trigger: 'deploy', prId: pr10 }).id;
  store.guardianRuns.update(g1, {
    status: 'failed',
    finished: true,
    areas: [
      {
        area: 'ui',
        passed: false,
        critical: false,
        failures: ['https://shop.example/a (200): the button is hidden'],
        flaky: false,
        errored: false,
      },
      {
        area: 'api',
        passed: false,
        critical: false,
        failures: ['the api check could not run (git fetch failed (128))'],
        flaky: false,
        errored: true,
      },
      { area: 'performance', passed: true, critical: false, failures: [], flaky: true, errored: false },
    ],
  });
  at('10-02T16:00');
  store.sessions.update(s2, { status: 'ended' });
  at('10-03T09:00');
  store.requests.create({
    projectId: shop,
    sessionId: s2,
    text: 'Thanks! mail me at someone@example.com',
    source: 'email',
  });

  // A PR that failed QA and a custom check, then went to the human.
  at('10-10T08:00');
  const s3 = session('s3');
  const reqB = store.requests.create({
    projectId: shop,
    sessionId: s3,
    text: 'Fix checkout | now',
    source: 'dashboard',
  }).id;
  at('10-10T09:00');
  const pr11 = pr(11, s3, reqB);
  store.pullRequests.update(pr11, {
    round: 5,
    outcome: 'escalated',
    loopState: { posted: ['qa-1-1111111', 'qa-2-2222222', 'check-lint-3-3333333', 'escalated-5-5555555'] },
  });
  at('10-10T10:00');
  store.questions.create({
    sessionId: s3,
    text: 'Merge anyway?',
    options: ['yes', 'no'],
    recommendedOption: 'no',
    timeoutMs: 2 * HOUR,
  });
  at('10-10T12:00');
  note(s3, 'PR web#11 sent to the human: The qa job for PR #11 failed 3 times.');
  note(s3, 'PR web#11: the human took over (The qa job for PR #11 failed 3 times).');
  at('10-10T12:01');
  store.questions.expireDue();

  // An agent that went away and was never resumed, with an open PR that also escalated.
  at('10-15T09:00');
  const s4 = session('s4');
  const pr12 = pr(12, s4, null);
  store.pullRequests.update(pr12, { round: 1, stage: 'escalated' }); // sent to the human, waiting
  at('10-15T10:00');
  note(
    s4,
    `The claude/opus agent of session ${s4} is gone (tmux window loop:@1 closed or its process exited). Session paused (agent_exited); resume relaunches it.`,
  );
  store.sessions.update(s4, { status: 'paused', pauseReason: 'agent_exited' });
  const q3 = store.questions.create({
    sessionId: s4,
    text: 'Restart it?',
    options: ['yes', 'no'],
    recommendedOption: 'yes',
    timeoutMs: 24 * HOUR,
  });
  at('10-15T12:30');
  store.questions.answer(q3.id, 'yes', 'dashboard');
  note(s4, 'PR web#12 sent to the human: The qa job for PR #12 failed 3 times.');

  // A daily Guardian run that could not check the api, and requests that never got anywhere.
  at('10-20T06:00');
  const g2 = store.guardianRuns.create({ projectId: shop, repo: 'web', trigger: 'daily' }).id;
  store.guardianRuns.update(g2, {
    status: 'error',
    finished: true,
    areas: [
      {
        area: 'api',
        passed: false,
        critical: false,
        failures: ['the api check could not run (git fetch failed (128))'],
        flaky: false,
        errored: true,
      },
    ],
  });
  store.requests.create({ text: 'Something, somewhere', source: 'email' });
  at('10-21T06:00');
  store.requests.create({ projectId: shop, text: 'Queued and forgotten', source: 'dashboard' });

  // Another project, and the next month: left out of a report of shop's October.
  store.sessions.create({ projectId: blog, title: 'b', model: 'opus', branch: 'b' });
  // A pause across the window's end: 4 of its 6 hours count.
  at('10-31T20:00');
  store.sessions.update(s3, { status: 'paused', pauseReason: 'manual' });
  at('11-01T01:00');
  session('november');
  at('11-01T02:00');
  store.sessions.update(s3, { status: 'active' });
  store.close();
  return { shop, blog };
}

describe('collectRetro on a month of made-up history', () => {
  let dir: string;
  let db: Database.Database;
  let ids: { shop: number; blog: number };
  let d: RetroData;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-retro-'));
    const path = join(dir, 'loop.db');
    ids = buildFixture(path);
    db = new Database(path, { readonly: true, fileMustExist: true });
    d = collectRetro(db, { window: OCTOBER, projectId: ids.shop, now: NOW });
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts sessions started, finished and still open', () => {
    expect(d.project).toEqual({ id: ids.shop, name: 'shop' });
    expect(d.sessions).toMatchObject({ started: 3, finished: 2, openAtEnd: 2, byRigor: { standard: 3 } });
    expect(d.sessions.duration).toMatchObject({ count: 1, median: 7 * HOUR });
    expect(collectRetro(db, { window: OCTOBER, now: NOW }).sessions.started).toBe(4); // with blog's
  });

  it('adds up pauses from the pause log, inside the window only', () => {
    expect(d.pauses.logged).toBe(true);
    expect(d.pauses.byReason.manual).toEqual({ pauses: 1, sessions: 2, pausedMs: 6 * HOUR });
    expect(d.pauses.longest.find((p) => p.startedAt.startsWith('2026-10-31'))).toMatchObject({
      reason: 'manual',
      ms: 6 * HOUR,
      ongoing: false,
    });
    expect(d.pauses.byReason.usage_limit).toEqual({ pauses: 1, sessions: 1, pausedMs: 1.5 * HOUR });
    // Never resumed or ended: paused until the window's end.
    expect(d.pauses.byReason.agent_exited).toEqual({
      pauses: 1,
      sessions: 1,
      pausedMs: (16 * 24 + 14) * HOUR,
    });
    expect(d.pauses.longest[0]).toMatchObject({ reason: 'agent_exited', ongoing: true });
    expect(d.pauses.usageLimit).toHaveLength(1);
    expect(d.pauses.agentGone).toHaveLength(1);
  });

  it('reports PRs by outcome, fix rounds and time to merge', () => {
    expect(d.prs).toMatchObject({
      opened: 3,
      byOutcome: { merged: 1, 'taken over': 1, escalated: 1 },
      mergedInWindow: 1,
      fixRounds: [1, 0, 1, 0, 1],
      costUsd: 2.5,
    });
    expect(d.prs.fixRoundStats).toMatchObject({ median: 2, max: 4 });
    expect(d.prs.mostRounds.map((x) => [x.pr.label, x.rounds])).toEqual([
      ['#11', 4],
      ['#10', 2],
    ]);
    expect(d.prs.openToMerge.median).toBe(5 * HOUR);
    expect(d.prs.requestToMerge.median).toBe(6 * HOUR);
    expect(d.prs.tookOver.map((e) => e.label)).toEqual(['#11']);
    expect(d.prs.tookOver[0]!.url).toBe('https://github.example/shop/web/pull/11');
  });

  it('counts failures per stage and groups the reasons', () => {
    const rows = Object.fromEntries(d.stages.rows.map((r) => [r.stage, [r.failures, r.jobFailures]]));
    expect(rows).toEqual({ qa: [2, 2], lint: [1, 0], tests: [1, 0] });
    expect(d.stages).toMatchObject({ reviewsPosted: 2, reviewSendBacks: 1, otherFailures: 1 });
    expect(d.stages.escalations.map((e) => e.label)).toEqual(['#11', '#12']);
    expect(d.reasons.slice(0, 2).map((g) => [g.count, g.sources])).toEqual([
      [2, ['guardian']],
      [2, ['escalation']],
    ]);
    expect(d.guardian).toMatchObject({ runs: 2, byStatus: { failed: 1, error: 1 }, critical: 0 });
    expect(d.guardian.areas).toEqual([
      { area: 'api', failed: 0, errored: 2, flaky: 0 },
      { area: 'ui', failed: 1, errored: 0, flaky: 0 },
      { area: 'performance', failed: 0, errored: 0, flaky: 1 },
    ]);
  });

  it('measures how long questions waited', () => {
    expect(d.questions).toMatchObject({
      asked: 3,
      byStatus: { answered: 2, defaulted: 1 },
      byChannel: { dashboard: 2 },
      over1h: 1,
    });
    expect(d.questions.answeredWait).toMatchObject({ count: 2, median: 0.75 * HOUR, max: 2.5 * HOUR });
    expect(d.questions.defaultedWait.max).toBe(2 * HOUR + 60_000);
  });

  it('finds requests that never finished', () => {
    // The unrouted request belongs to no project: only a report of every project has it.
    expect(d.requests.byOutcome).toEqual({
      merged: 1,
      in_progress: 1,
      ended_without_merge: 1,
      no_session: 1,
      unrouted: 0,
    });
    const all = collectRetro(db, { window: OCTOBER, now: NOW });
    expect(all.requests.byOutcome.unrouted).toBe(1);
  });

  it('ranks the problems with their evidence', () => {
    expect(d.problems.map((p) => p.count)).toEqual([2, 2, 2, 2, 2, 2, 2, 1, 1, 1]);
    expect(
      d.problems.find((p) => p.title === 'qa failed and sent the PR back')?.evidence.map((e) => e.label),
    ).toEqual(['#11']);
    const titles = d.problems.map((p) => p.title);
    expect(titles).toContain('the qa job itself kept failing');
    expect(titles).toContain('requests that never finished');
    expect(titles.some((t) => t.startsWith('recurring: the qa job for PR'))).toBe(false); // examples keep case
    expect(titles.some((t) => t.startsWith('recurring: The qa job for PR #11 failed 3 times'))).toBe(true);
  });

  it('renders the same Markdown every time, with secrets and addresses masked', () => {
    const md = renderRetro(d);
    expect(renderRetro(collectRetro(db, { window: OCTOBER, projectId: ids.shop, now: NOW }))).toBe(md);
    expect(md).toContain('# Loop retro: 2026-10-01 to 2026-10-31 (UTC)');
    expect(md).toContain('| Sessions started / finished | 3 / 2 |');
    expect(md).toContain('| usage_limit | 1 | 1 | 1h 30m |');
    expect(md).toContain('[#11](https://github.example/shop/web/pull/11)');
    expect(md).toContain('&lt;email&gt;');
    expect(md).not.toContain('someone@example.com');
    expect(md).toContain('Fix checkout \\| now');
  });

  it('writes a short request that fits the API', () => {
    const text = retroRequestText(d, '2026-10-shop.md');
    expect(text.length).toBeLessThanOrEqual(RETRO_REQUEST_MAX);
    expect(text).toContain('propose improvements to the pipeline');
    expect(text).toMatch(/^\d+\. qa failed and sent the PR back: 2$/m);
  });

  it('says so when nothing happened', () => {
    const empty = collectRetro(db, {
      window: { since: '2025-01-01T00:00:00.000Z', until: '2025-02-01T00:00:00.000Z' },
      now: NOW,
    });
    expect(empty.problems).toEqual([]);
    const md = renderRetro(empty);
    expect(md).toContain('Nothing went wrong that the database records.');
    expect(md).toContain('| Time paused | not logged in this window |');
  });
});

describe('collectRetro: reverts, automatic resumes and two projects with a repo of the same name', () => {
  it('keys PRs by project, reports reverts apart and counts only resumes that worked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-retro-'));
    try {
      const path = join(dir, 'loop.db');
      const clock = new FakeClock('2026-10-05T09:00:00.000Z');
      const store = openStore({ path, clock });
      const web = (owner: string) => [
        {
          name: 'web',
          path: `/src/${owner}`,
          remote: `git@example.com:${owner}/web.git`,
          defaultBranch: 'main',
        },
      ];
      const a = store.projects.create({ name: 'a', repos: web('a') }).id;
      const b = store.projects.create({ name: 'b', repos: web('b') }).id;
      const s = store.sessions.create({ projectId: a, title: 's', model: 'opus', branch: 's' }).id;
      const open = (projectId: number, number: number) =>
        store.pullRequests.create({
          projectId,
          repo: 'web',
          number,
          url: `https://github.example/${projectId}/${number}`,
        }).id;
      // Row ids differ from PR numbers, as in real databases.
      const b120 = open(b, 120);
      const a120 = open(a, 120);
      const a130 = open(a, 130);
      const merged = (projectId: number, n: number) =>
        store.history.add({ projectId, kind: 'decision', text: `PR web#${n} merged (squash) as 1111111.` });
      clock.set('2026-10-05T10:00:00.000Z');
      merged(a, 120);
      clock.set('2026-10-05T11:00:00.000Z');
      merged(b, 120);
      store.pullRequests.update(b120, { outcome: 'merged', stage: 'deployed' });
      clock.set('2026-10-05T12:00:00.000Z');
      merged(a, 130);
      store.pullRequests.update(a130, { outcome: 'merged', stage: 'deploying' });
      // A finished revert, as the engine leaves it: the revert merged without its revertOf, the
      // original reverted and pointing at it.
      const r121 = open(a, 121);
      store.pullRequests.update(r121, { outcome: 'merged', stage: 'merge', loopState: {} });
      store.pullRequests.update(a120, { outcome: 'reverted', stage: 'reverted', revertedByPrId: r121 });
      store.history.add({ projectId: a, kind: 'decision', text: 'PR web#120 reverted by #121 (3333333).' });
      // A revert still in flight: revertOf is the original's row id.
      const r131 = open(a, 131);
      store.pullRequests.update(r131, { stage: 'merge', loopState: { revertOf: a130 } });
      store.pullRequests.update(a130, { revertedByPrId: r131 });
      // A PR whose escalation nobody answered, and one the human took.
      const a140 = open(a, 140);
      store.pullRequests.update(a140, { outcome: 'escalated', stage: 'escalated' });
      store.history.add({
        projectId: a,
        kind: 'decision',
        text: 'PR web#140: nobody answered, so it left the loop (PR #140 hit 5 rounds).',
      });
      const a141 = open(a, 141);
      store.pullRequests.update(a141, { outcome: 'escalated', stage: 'escalated' });
      store.history.add({
        projectId: a,
        kind: 'decision',
        text: 'PR web#141: the human took over (stalled).',
      });
      store.history.add({
        projectId: a,
        sessionId: s,
        kind: 'decision',
        text: 'Auto-resume: try 1 of 3 failed: no tmux',
      });
      store.history.add({
        projectId: a,
        sessionId: s,
        kind: 'decision',
        text: 'Auto-resume: try 2 of 3: relaunched the agent 2 min after it was found gone.',
      });
      store.close();
      const db = new Database(path, { readonly: true });
      const d = collectRetro(db, { window: OCTOBER, now: NOW });
      expect(d.prs).toMatchObject({
        opened: 5,
        byOutcome: { reverted: 1, merged: 2, 'left the loop (nobody answered)': 1, 'taken over': 1 },
        mergedInWindow: 3,
      });
      // Each PR #120 has its own project's merge time: 1h and 2h after opening; #130 3h.
      expect(d.prs.openToMerge).toMatchObject({ count: 3, median: 2 * HOUR, max: 3 * HOUR });
      expect(d.prs.reverted).toEqual([
        { label: 'a/web#120 (reverted by #121)', url: `https://github.example/${a}/120` },
      ]);
      // Two projects: every PR label names its project, so a/web#120 and b/web#120 stay apart.
      expect(d.prs.revertPrs.map((e) => e.label)).toEqual([
        'a/web#121 (revert of a/web#120)',
        'a/web#131 (revert of a/web#130)',
      ]);
      expect(d.prs.leftLoop.map((e) => e.label)).toEqual(['a/web#140']);
      expect(d.prs.tookOver.map((e) => e.label)).toEqual(['a/web#141']);
      // One project: plain numbers.
      const alone = collectRetro(db, { window: OCTOBER, projectId: a, now: NOW });
      db.close();
      expect(alone.prs.revertPrs.map((e) => e.label)).toEqual([
        '#121 (revert of #120)',
        '#131 (revert of #130)',
      ]);
      expect(d.pauses.autoResumes.map((e) => e.label)).toEqual([`session ${s}`]);
      expect(d.pauses.autoResumeFailed.map((e) => e.label)).toEqual([`session ${s}`]);
      // A label carries project and repo names, the owner's own text: escaped, so "]" cannot end the link.
      const odd = {
        ...d,
        prs: { ...d.prs, reverted: [{ label: 'b]x/my_web#1', url: 'https://github.example/b/1' }] },
      };
      expect(renderRetro(odd)).toContain('[b\\]x/my\\_web#1](https://github.example/b/1)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retro helpers', () => {
  it('picks the previous calendar month and names it', () => {
    expect(previousMonth(new Date('2026-01-15T10:00:00Z'))).toEqual({
      since: '2025-12-01T00:00:00.000Z',
      until: '2026-01-01T00:00:00.000Z',
    });
    expect(retroFileName(OCTOBER)).toBe('2026-10.md');
    expect(retroFileName(OCTOBER, { id: 3, name: 'Shop Web!' })).toBe('2026-10-shop-web.md');
    expect(retroFileName(OCTOBER, { id: 3, name: '???' })).toBe('2026-10-project-3.md');
  });

  it('reads --since, --until and --days', () => {
    const now = new Date('2026-11-06T08:00:00Z');
    expect(windowFromFlags({}, now)).toEqual(OCTOBER);
    expect(windowFromFlags({ since: '2026-10-01', until: '2026-10-31' }, now)).toEqual(OCTOBER);
    expect(windowFromFlags({ since: '2026-11-01' }, now)).toEqual({
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-11-06T08:00:00.000Z',
    });
    const week = windowFromFlags({ days: '7' }, now);
    expect(week).toEqual({ since: '2026-10-30T08:00:00.000Z', until: '2026-11-06T08:00:00.000Z' });
    expect(retroFileName(week)).toBe('2026-10-30_to_2026-11-06.md');
    expect(describeWindow(OCTOBER)).toBe('2026-10-01 to 2026-10-31 (UTC)');
    expect(() => windowFromFlags({ days: '7', since: '2026-10-01' }, now)).toThrow(/cannot be combined/);
    expect(() => windowFromFlags({ days: '0' }, now)).toThrow(/whole number/);
    expect(() => windowFromFlags({ until: '2026-10-01' }, now)).toThrow(/needs --since/);
    expect(() => windowFromFlags({ since: '2026-02-30' }, now)).toThrow(/not a date/);
    expect(() => windowFromFlags({ since: 'yesterday' }, now)).toThrow(/needs a date/);
    expect(() => windowFromFlags({ since: '2026-10-01T10:00' }, now)).toThrow(/with its zone/);
    expect(windowFromFlags({ since: '2026-10-01T10:00+02:00' }, now).since).toBe('2026-10-01T08:00:00.000Z');
    expect(() => windowFromFlags({ since: '2026-10-05', until: '2026-10-01' }, now)).toThrow(/before/);
  });

  it('groups failure texts that differ only in numbers, links and hashes', () => {
    expect(reasonKey('The tests job for PR #9 failed 3 times')).toBe(
      reasonKey('The tests job for PR #21 failed 2 times'),
    );
    expect(reasonKey('see https://a.example/x at abc1234')).toBe(
      reasonKey('see https://b.example/y at def5678'),
    );
    expect(stats([5, 1, 3])).toEqual({ count: 3, median: 3, p90: 5, max: 5, total: 9 });
    expect(stats([])).toEqual({ count: 0, median: null, p90: null, max: null, total: 0 });
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
    expect(formatDuration(50 * HOUR)).toBe('2d 2h');
    expect(cleanText('a\nb | <c>', 20)).toBe('a b \\| &lt;c&gt;');
    expect(cleanText('a_b [c](d) *e*', 40)).toBe('a\\_b \\[c\\](d) \\*e\\*');
    expect(cleanText('a_b [c](d) *e* x@example.com', 40, [], false)).toBe('a_b [c](d) *e* <email>');
  });
});
