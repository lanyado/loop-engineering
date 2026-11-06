import { PAUSE_REASONS, redactSecrets } from '@loop-engineering/core';
import { byText, type Evidence, type RequestOutcome, type RetroData, type Stats } from './retro.js';
import { describeWindow } from './retro-window.js';

/**
 * One line of untrusted text for Markdown: token shapes, `secrets` (the server's and the projects'
 * secret values) and addresses masked, cut to `max`, and every character that Markdown or HTML would
 * read as markup (links, emphasis, code, table cells, tags) escaped; `markdown: false` leaves the
 * markup alone, for plain text.
 */
export function cleanText(text: string, max = 120, secrets: readonly string[] = [], markdown = true): string {
  const line = redactSecrets(text, secrets)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = line.length > max ? `${line.slice(0, max - 1)}…` : line;
  if (!markdown) return cut;
  return cut
    .replace(/[\\`*_[\]|]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const durations = (s: Stats) =>
  s.count === 0
    ? 'none'
    : `median ${formatDuration(s.median)}, p90 ${formatDuration(s.p90)}, max ${formatDuration(s.max)} (${s.count})`;

const link = (e: Evidence) => (e.url ? `[${e.label}](${e.url})` : e.label);
const links = (items: Evidence[], max = 8) => {
  const seen = [...new Map(items.map((e) => [e.label, e])).values()];
  const shown = seen.slice(0, max).map(link).join(', ');
  return seen.length > max ? `${shown} and ${seen.length - max} more` : shown;
};
const counts = (r: Record<string, number>) =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'none';
const usd = (n: number) => `$${n.toFixed(2)}`;

const OUTCOME_LABEL: Record<RequestOutcome, string> = {
  merged: 'a PR merged',
  in_progress: 'still in progress',
  ended_without_merge: 'session ended, nothing merged',
  no_session: 'never got a session',
  unrouted: 'never routed to a project',
};

export interface RenderOptions {
  /** Secret values to mask besides token shapes (secretValues of the env, the projects' env files). */
  secrets?: readonly string[];
}

/** The report as Markdown. Deterministic: the same data gives the same text. */
export function renderRetro(d: RetroData, options: RenderOptions = {}): string {
  const clean = (text: string, max: number) => cleanText(text, max, options.secrets);
  const out: string[] = [];
  const p = (line = '') => out.push(line);
  const pausedTotal = PAUSE_REASONS.reduce((a, r) => a + d.pauses.byReason[r].pausedMs, 0);
  const notFinished = d.requests.created - d.requests.byOutcome.merged;

  p(`# Loop retro: ${describeWindow(d.window)}`);
  p();
  p(
    `${d.project ? `Project **${clean(d.project.name, 80)}**` : 'All projects'}. Made by \`loop retro\` at ` +
      `${d.generatedAt.slice(0, 16).replace('T', ' ')} UTC from the loop's database (SQL and code only, no model). ` +
      'What each number means is at the end.',
  );
  p();
  p('## At a glance');
  p();
  p('| | |');
  p('| --- | --- |');
  p(`| Sessions started / finished | ${d.sessions.started} / ${d.sessions.finished} |`);
  p(`| PRs opened / merged | ${d.prs.opened} / ${d.prs.mergedInWindow} |`);
  p(
    `| Fix rounds per PR | ${d.prs.fixRoundStats.count ? `median ${d.prs.fixRoundStats.median}, max ${d.prs.fixRoundStats.max}` : 'none'} |`,
  );
  p(`| Request to merge | ${durations(d.prs.requestToMerge)} |`);
  p(
    `| Questions to humans | ${d.questions.asked} (answered ${d.questions.byStatus.answered ?? 0}, nobody answered ${d.questions.byStatus.defaulted ?? 0}) |`,
  );
  p(`| Requests not finished | ${notFinished} of ${d.requests.created} |`);
  p(`| Time paused | ${d.pauses.logged ? formatDuration(pausedTotal) : 'not logged in this window'} |`);
  p(`| Loop cost of the PRs opened | ${usd(d.prs.costUsd)} |`);
  p();

  p('## Top recurring problems');
  p();
  if (d.problems.length === 0) p('Nothing went wrong that the database records.');
  d.problems.forEach((x, i) =>
    p(`${i + 1}. **${clean(x.title, 160)}**: ${x.count}. Evidence: ${links(x.evidence)}`),
  );
  p();

  p('## Sessions');
  p();
  p(
    `- Started: ${d.sessions.started}; finished: ${d.sessions.finished}; still open at the end: ${d.sessions.openAtEnd}.`,
  );
  p(`- Rigor of the sessions started: ${counts(d.sessions.byRigor)}. CLI: ${counts(d.sessions.byProvider)}.`);
  p(`- Length of the sessions started and finished in the window: ${durations(d.sessions.duration)}.`);
  p();

  p('## Pauses');
  p();
  p('| Reason | Pauses started | Sessions paused | Time paused |');
  p('| --- | --- | --- | --- |');
  for (const r of PAUSE_REASONS) {
    const x = d.pauses.byReason[r];
    p(`| ${r} | ${x.pauses} | ${x.sessions} | ${formatDuration(x.pausedMs)} |`);
  }
  p();
  if (!d.pauses.logged)
    p(
      '- No pause log entries in this window: pauses from before the pause log existed only show in the events below.',
    );
  const ev = (label: string, items: Evidence[], extra = '') =>
    p(`- ${label}: ${items.length}${extra}${items.length ? ` (${links(items)})` : ''}.`);
  ev(
    'Claude usage limit reached',
    d.pauses.usageLimit,
    d.pauses.usageLimitFallbacks ? `, ${d.pauses.usageLimitFallbacks} moved to OpenCode` : '',
  );
  ev('Agent exited or its window closed', d.pauses.agentGone);
  ev('Automatic resumes', d.pauses.autoResumes);
  ev('Automatic resume tries that failed', d.pauses.autoResumeFailed);
  ev('Automatic resume gave up', d.pauses.autoResumeGaveUp);
  ev('Moved to another model', d.pauses.modelMoves);
  if (d.pauses.longest.length) {
    p();
    p('Longest pauses:');
    p();
    for (const x of d.pauses.longest.slice(0, 5))
      p(
        `- session ${x.sessionId}: ${formatDuration(x.ms)} (${x.reason}, from ${x.startedAt.slice(0, 16).replace('T', ' ')}${x.ongoing ? ', still paused' : ''})`,
      );
  }
  p();

  p('## Pull requests');
  p();
  p(`- Opened: ${d.prs.opened}. Where they are now: ${counts(d.prs.byOutcome)}.`);
  p(`- Merged in the window (whenever opened): ${d.prs.mergedInWindow}.`);
  const [r0, r1, r2, r3, r4] = d.prs.fixRounds;
  p(`- Fix rounds: 0: ${r0}, 1: ${r1}, 2: ${r2}, 3: ${r3}, 4 or more: ${r4}.`);
  if (d.prs.mostRounds.length)
    p(
      `- Most fix rounds: ${d.prs.mostRounds.map((x) => `${link(x.pr)} ${x.rounds} (${x.outcome})`).join(', ')}.`,
    );
  p(`- Opened to merged: ${durations(d.prs.openToMerge)}.`);
  p(`- Request to merged: ${durations(d.prs.requestToMerge)}.`);
  if (d.prs.slowest.length)
    p(
      `- Slowest from request to merge: ${d.prs.slowest.map((x) => `${link(x.pr)} ${formatDuration(x.ms)}`).join(', ')}.`,
    );
  ev('The human took over', d.prs.tookOver);
  ev('Left the loop because nobody answered its escalation', d.prs.leftLoop);
  ev('Given back to the loop', d.prs.returned);
  ev('A check skipped by the human', d.prs.skippedChecks);
  ev('Reverted after merging', d.prs.reverted);
  ev('Revert PRs (left out of the numbers above)', d.prs.revertPrs);
  p(
    `- Loop cost of these PRs: ${usd(d.prs.costUsd)}, ${d.prs.tokensIn.toLocaleString('en-US')} tokens in, ${d.prs.tokensOut.toLocaleString('en-US')} out.`,
  );
  p();

  p('## Stage failures');
  p();
  if (d.stages.rows.length === 0) p('No check failed.');
  else {
    p('| Stage | Failed (sent back) | Job kept failing | PRs |');
    p('| --- | --- | --- | --- |');
    for (const r of d.stages.rows)
      p(
        `| ${clean(r.stage, 40)} | ${r.failures} | ${r.jobFailures} | ${links([...r.evidence, ...r.jobEvidence], 6)} |`,
      );
  }
  p();
  p(
    `- Reviews posted: ${d.stages.reviewsPosted}; review rounds followed by another round with no other check failing (most likely changes requested): ${d.stages.reviewSendBacks}.`,
  );
  p(`- Failures no stage comment explains (CI, mostly): ${d.stages.otherFailures}.`);
  ev('Escalations to the human', d.stages.escalations);
  p();

  p('## Most common failure reasons');
  p();
  if (d.reasons.length === 0) p('None recorded.');
  else {
    p('| Times | Where | Example | Evidence |');
    p('| --- | --- | --- | --- |');
    for (const g of d.reasons)
      p(`| ${g.count} | ${g.sources.join(', ')} | ${clean(g.example, 200)} | ${links(g.evidence, 5)} |`);
  }
  p();

  p('## Production Guardian');
  p();
  p(`- Runs: ${d.guardian.runs} (${counts(d.guardian.byStatus)}); critical: ${d.guardian.critical}.`);
  if (d.guardian.areas.length) {
    p();
    p('| Area | Failed | Could not run | Flaky |');
    p('| --- | --- | --- | --- |');
    for (const a of d.guardian.areas) p(`| ${clean(a.area, 40)} | ${a.failed} | ${a.errored} | ${a.flaky} |`);
  }
  p();

  p('## Questions to humans');
  p();
  p(
    `- Asked: ${d.questions.asked}. By whom: ${counts(d.questions.byOrigin)}. Status: ${counts(d.questions.byStatus)}.`,
  );
  p(`- Answered through: ${counts(d.questions.byChannel)}.`);
  p(`- Wait for an answer: ${durations(d.questions.answeredWait)}; over an hour: ${d.questions.over1h}.`);
  p(
    `- Unanswered until the default was taken: ${durations(d.questions.defaultedWait)}; asked by: ${counts(d.questions.defaultedByOrigin)}.`,
  );
  if (d.questions.longest.length) {
    p();
    p('Longest waits:');
    p();
    for (const q of d.questions.longest)
      p(
        `- question ${q.questionId} (session ${q.sessionId}, ${q.origin}, ${q.status}): ${formatDuration(q.waitMs)}: "${clean(q.text, 100)}"`,
      );
  }
  p();

  p('## Requests');
  p();
  p(`- Created: ${d.requests.created}. From: ${counts(d.requests.bySource)}.`);
  p(
    `- ${(Object.keys(OUTCOME_LABEL) as RequestOutcome[]).map((o) => `${OUTCOME_LABEL[o]}: ${d.requests.byOutcome[o]}`).join('; ')}.`,
  );
  if (d.requests.unfinished.length) {
    p();
    p('Not finished:');
    p();
    for (const r of d.requests.unfinished.slice(0, 15))
      p(
        `- request ${r.id} (${r.source}, ${r.createdAt.slice(0, 10)}${r.sessionId === null ? '' : `, session ${r.sessionId}`}): ${OUTCOME_LABEL[r.outcome]}: "${clean(r.text, 100)}"`,
      );
    if (d.requests.unfinished.length > 15) p(`- and ${d.requests.unfinished.length - 15} more`);
  }
  p();

  p('## How these numbers are made');
  p();
  p(
    [
      '- Times are UTC. Things that started in the window count; their state (merged, open) is as of now.',
      "- Sessions are the runner's own (imported past conversations are left out); the router's reserved project is left out of everything but questions.",
      '- Pauses come from the pause log (one history entry per pause, change of reason and resume). "Pauses started" counts those that began in the window; "Sessions paused" and "Time paused" also include pauses carried in from before it, for their part inside the window. Pauses under a minute (a relaunch passes through one) are left out. Usage limit, agent exits and automatic resumes are counted from the runner\'s history entries.',
      '- Medians and p90s are nearest-rank: with an even count the median is the lower of the two middle values.',
      '- PRs: "escalated" is waiting on the human, "taken over" is the human\'s now, "left the loop" was escalated and nobody answered; a PR merged and then reverted counts as merged (and as reverted), and the loop\'s own revert PRs are left out.',
      "- Fix rounds are the PR's round minus one: each new head after the first went through the checks again.",
      '- Stage failures are the "… failed" comments the loop posted (one per failed verdict) on PRs opened in the window; "job kept failing" counts escalations dated in the window because the job itself crashed or gave no verdict, whenever its PR was opened.',
      '- A request is finished when a PR from it (or from a part of it) merged, or its session merged a PR after it arrived. Thank-you notes and questions that need no PR show as not finished.',
      '- Failure reasons group texts that differ only in numbers, links or hashes: escalations, closures, loop errors and Production Guardian findings.',
      '- Top problems rank every kind of problem by how often it happened; each names its evidence (PRs link to GitHub).',
    ].join('\n'),
  );
  return `${out.join('\n')}\n`;
}

/** Request text limit of POST /api/requests; the full report goes along as an attached file. */
export const RETRO_REQUEST_MAX = 3_800;

/** The request `loop retro --file-request` files: the task, the headline numbers, the top problems. */
export function retroRequestText(d: RetroData, fileName: string, options: RenderOptions = {}): string {
  // Plain text (the request is not rendered as Markdown): secrets masked, no escaping.
  const clean = (text: string, max: number) => cleanText(text, max, options.secrets, false);
  const head = [
    `Retro of the loop for ${describeWindow(d.window)}${d.project ? ` (${clean(d.project.name, 80)})` : ''}: propose improvements to the pipeline and its prompts.`,
    '',
    `The full report is attached (${fileName}); it was made from the loop's database by \`loop retro\`. Read it, then propose concrete changes to the pipeline (its stages, their order, their prompts, the rigor and model choices) that would have prevented the top problems below. Tie each proposal to the evidence in the report (PR numbers, session ids) and say what number it should move next month. If this project has its own pipeline (a .loop-engineering/ folder), make the changes there in one PR; otherwise open no PR and reply with the proposals. Do not change product code for this.`,
    '',
    'Top problems:',
  ];
  const problems = d.problems.map((x, i) => `${i + 1}. ${clean(x.title, 160)}: ${x.count}`);
  if (problems.length === 0) problems.push('none recorded');
  let text = [...head, ...problems].join('\n');
  if (text.length > RETRO_REQUEST_MAX) text = `${text.slice(0, RETRO_REQUEST_MAX - 1)}…`;
  return text;
}
