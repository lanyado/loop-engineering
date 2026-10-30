# Suggestions: a smoother, faster, higher-quality loop

Based on the recorded session and decision history (sessions 81–109, Oct 18–30), the stage prompts
(`packages/loop/stages/*.md`), `packages/loop/src/prompts.ts`, `packages/runner/src/instructions.ts`
and the defaults in `packages/loop/src/engine.ts`. **Evidence** marks what the history shows;
**Judgment** marks my inference. The history is partial, so treat the numbers as indicative.

## What the history shows

| Signal                                                                     | Evidence                                                                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Review/QA jobs failing three times, then escalating to the human           | PRs #30, #31, #32, #33, #35 on Oct 19                                                                                             |
| Long review ping-pong                                                      | #33 took 11 rounds (hit 10, human took over), #26 took 6, #32 took 6; one-round PRs (PRs #25, #27 and #40) were small and focused |
| Provider rate limits cascading through free OpenCode models                | Sessions 86, 87, 89 hopped `deepseek-flash` → `big-pickle` → `nemotron` in under a minute                                         |
| Network outages counted as failed attempts                                 | Request #27 (a dashboard request, not PR #27; session 94, Oct 21)                                                                 |
| CI failing on a test that asserted job order after the stage order changed | Request #23, `engine.test.ts`                                                                                                     |
| The loop's own pushes (tester's tests) restarting review                   | PR #21 "hit 5 rounds (new commits kept arriving)"                                                                                 |

## Prompt changes

1. **Review: report everything in one pass.** Add to `review.md`: "List every blocking issue in this
   round. Do not hold issues back for later rounds, and do not raise new blocking issues about code
   that was unchanged since the last round." _Why (judgment):_ #33 and #26 look like drip-fed findings.
2. **Review: define "blocking" narrowly.** Blocking = wrong behaviour, a missed requirement, a
   security flaw, or a missing test for new behaviour. Naming, structure and "could also" ideas are
   Optional. Ask for a `file:line` and a concrete failure scenario for every blocking item, and drop
   items that cannot give one.
3. **Review: re-check only the previous blockers on later rounds.** After round 2, restrict the
   reviewer to "are the previous blocking items fixed, and did the fix introduce a regression".
   This bounds rounds without lowering the bar.
4. **Builder (`instructions.ts`): run typecheck and lint before pushing, and run the tests that
   mention any behaviour you changed.** Step 3 only says "relevant existing tests or lint if they
   exist and are quick". Name the repo's commands (`npm run typecheck`, `npm run lint`) so CI
   failures like request #23 are caught before the PR exists. Also: "when you change a prompt,
   stage order or constant, grep the tests for it".
5. **Builder: keep the PR small and say what you did not do.** Add "one concern per PR; list known
   gaps in the PR body". One-round PRs were the small ones.
6. **Builder: put a "how to verify" line in the PR body** (command or URL) so the tester and QA
   spend less time discovering how to run things.
7. **Planner: say which files and tests you will touch and what is out of scope.** The plan is
   already shown on the dashboard; make the reviewer see it too (see system change 6) so scope
   creep and missed requirements are caught against the plan, not just the request.
8. **Tests stage: prefer exact commands.** "Aim for 10 minutes" is good; add "if the package has a
   test script with a path filter, use it; report the exact commands and their exit codes". The
   tester's output feeds the next builder round, so precision pays.
9. **QA: skip when `tests.md` decided no manual QA is needed, and record why** in the PR comment
   (already implied; make it explicit so a skipped QA is not read as a missed one).

## System changes

1. **Make the escalation reason actionable.** "The review job failed 3 times" gives the human no
   clue whether it was a rate limit, a timeout or malformed JSON. Attach the last error line and
   job log path to the escalation card.
2. **Rate limits: already handled per model; close the remaining gap.** The engine classifies
   rate-limit, quota and 429 errors as `MODEL_LIMIT` (`engine.ts:106`), rests the limited model for
   `MODEL_REST_MS` (15 min) and retries the next OpenCode model, and retries on OpenCode after a
   Claude usage limit (`engine.ts:1676-1695`). What is not covered (judgment): when every model in
   the chain is limited, the job still fails and spends one of the `maxAttempts: 3`. In that case
   pause with back-off and jitter, as the network-outage logic (request #27) does, instead of
   consuming attempts and escalating.
3. **Spread across providers.** The existing rest is per model, so the free OpenCode models that
   share one upstream limit (session 86/87/89) can hop one after another and all fail. Group
   models by provider or upstream so one limit rests the whole group, and keep the stronger model
   for review.
4. **Raise the cap for Thorough.** Per-rigor caps already exist: Fast is capped at one round and
   Light at two (`packages/loop/src/rigor.ts:26-31`, applied in `engine.ts:2006-2008`), while
   Standard and Thorough both use `maxRounds: 5`. The gap is that Thorough, the level for risky
   changes, has no higher budget; suggest Thorough = 7. The dashboard shows "round N/max"
   (`apps/dashboard/src/lib/format.ts:13-23`) only for Standard and Thorough, so Fast and Light show
   no denominator; show it there too. After the cap, escalate with a summary of unresolved
   blockers instead of a bare "hit N rounds".
5. **Do not let the loop's own commits restart review needlessly.** The tester pushing tests
   re-triggers review (#21). Review the tester's delta only when it touches non-test files, or
   batch the tester's commit into the round already in progress.
6. **Give the reviewer the plan and the tester's results.** Include the Planner's plan and the
   Tests-stage summary in `reviewPrompt` next to the request. It reduces "missing test" and
   "missed requirement" findings that the earlier stages already settled.
7. **Detect repeat findings.** If a blocking item in round N is textually near-identical to one the
   builder already answered, show the builder's reply to the reviewer and ask for a ruling, or flag
   it for the human after two repeats. This is the usual cause of 6+ round PRs. (judgment)
8. **Speed: cache dependency installs per project.** Tests and QA run in fresh scratch checkouts and
   each starts with `npm install` ("Worktree has no node_modules" in session 107). A shared npm
   cache, or a prepared `node_modules` snapshot per base SHA, removes minutes from every PR.
9. **Speed: run tests and the lighter checks in parallel when they do not edit.** Review is
   read-only; it can start alongside tests unless the tester is expected to change the diff, in
   which case only re-run review on the delta. `maxConcurrentJobs: 2` already permits it.
10. **Track per-stage metrics.** Record duration, attempts, rounds, escalations and cost per PR and
    per stage, and show the median and worst on the dashboard. Without this, tuning is guesswork:
    every number above had to be pieced together from decision text.
11. **Make decision records structured.** Search results were free-text snippets. Store
    `{pr, stage, reason_code, round, model}` so "why did PRs escalate this week" is a query, and so a
    later session like this one can compute rather than infer.
12. **Prompt regression tests.** Prompts live in markdown and `prompts.ts`; add a small snapshot test
    that the fixed rules (`DATA_RULE`, `NO_PUSH`, the JSON decision format) survive any stage-file
    edit, and an offline eval set of 5–10 past PR diffs with known findings to compare reviewer prompt
    versions before rolling one out.

## Suggested order

1. Prompt items 1–4 and system item 1 (cheap, immediate effect on rounds and escalations).
2. System items 2 and 3 (rate limits), then 4 and 5 (round policy).
3. System items 8 and 10 (speed and visibility), then 6, 7, 11, 12.
