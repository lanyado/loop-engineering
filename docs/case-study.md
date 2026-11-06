# Case study: a week of unattended work

A small team building a children's content site ran Loop Engineering on one always-on Linux server in the first week of November 2026, mostly without anyone watching it. This page covers what happened and what broke along the way, with the numbers `loop retro` produced for 2026-11-01 to 2026-11-06. The site, its people and its repositories stay unnamed.

## The setup

- **The site.** Hebrew and English: browser games, comics, coloring pages, and voice lines recorded for its characters. Many changes are to games, which have browser tests.
- **The team.** A few people sending tasks by email and through the dashboard, in both languages. One technical owner got the loop's own decisions and the agents' technical questions.
- **The machine.** One Debian server with 12 CPUs and 31 GB of RAM, running the server, the dashboard, the builders in tmux and the PR loop's jobs. [The guide](unattended.md) describes the same setup.
- **The pipeline.** Tests, code review, QA in a browser, merge, deploy watch, and the Production Guardian checking the live site after each deploy and once a day.

## The week in numbers

| Measure                     | Value                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| Sessions started / finished | 62 / 62                                                                   |
| PRs opened / merged         | 59 / 59                                                                   |
| Fix rounds per PR           | median 0, max 4                                                           |
| Request to merge            | median 49m, p90 11h 12m                                                   |
| Questions to people         | 32: 9 answered (median 3m), 23 took their default (after a median of 15m) |
| Requests not finished       | 3 of 92                                                                   |
| Production Guardian runs    | 68: 50 passed, 12 failed, 6 errored                                       |
| Loop cost of the PRs        | about $277                                                                |

What the numbers say:

- **Most PRs passed every check the first time.** The median PR needed no fix round, and the worst needed four. Every PR opened that week was merged.
- **Half the PRs were merged within 49 minutes of their request.** The slow tail, with a p90 over 11 hours, includes work held up by the incidents below.
- **People answered few questions.** 23 of 32 questions took their default after 15 minutes, because nobody who could answer was around. Agents are told to recommend the safe choice and to say in their work when a default decided something, so a default is a decision rather than a stall. When someone did answer, it took a median of 3 minutes.
- **The Guardian is noisy but useful.** 12 failed runs out of 68 is a lot to read. Beyond those, flaky UI and API checks passed on their retry, and the Guardian records those as flaky rather than failed. The 6 errored runs were checks that could not run at all, and they were retried later.
- **3 of 92 requests never finished.** There are fewer sessions than requests because a follow-up for an open session is delivered into it rather than starting a new one.
- **About $277** is what the agent CLIs reported for the loop's own jobs on those 59 PRs: tests, review, QA and conflict fixes. The builder sessions are not in that figure.

## What broke, and what changed

Each of these led to a change in Loop that week.

### The tmux server died and took every builder with it

Early one morning, the tmux server holding the builders exited, and three builders closed at once. There was no out-of-memory kill, no crash in the kernel log, and no update or restart. tmux keeps no log, so the cause is still unknown. Loop paused the three sessions correctly, but nothing resumed them and nobody was told. They sat idle for two hours until someone resumed them by hand.

**Changed:** [automatic resume](reference.md#the-pr-loop) after 1, 5 and 15 minutes, at most 3 times a day. The agent's first prompt says its terminal closed and its background commands may have died. Loop now remembers the tmux server's pid and start time. When the server dies, one alert names every session and what happens to each, and a history entry says how long the server ran. New windows set `remain-on-exit` in the same command that creates them, so an agent that exits leaves its window to inspect.

### Test runs hung at 0% CPU

Builders and the loop's jobs ran their browser suites whenever they liked. The load average reached 56–67 on 12 CPUs, QA jobs hit their 15-minute limit, and some test runs hung at 0% CPU, holding the builder that waited for them.

**Changed:** [`scripts/heavy`](unattended.md#limits-on-load), a machine-wide limit on heavy runs (3 slots by default) with a time limit per run. The loop's jobs take a slot automatically, and builders are told to use it. A job killed at its timeout gets twice the time on its next try, and waiting for a slot no longer counts as job time. A builder idle with a background shell running is told after 45 minutes that its run may have hung.

### `/tmp` filled up, and it was RAM

On that Debian release, `/tmp` is a RAM-backed `tmpfs` that takes up to half the machine's memory. Test output, temporary checkouts and the agents' background-task output collect there, so a full `/tmp` is also memory the machine no longer has.

**Changed:** the guide says to give Loop a [temp folder on disk](unattended.md#temporary-files) through `TMPDIR` in its service, or to put `/tmp` back on disk, and to watch it either way.

### GitHub's SSH went down

During an SSH outage at GitHub, pushes failed with `Permission denied (publickey)` for a key that was fine, while GitHub's API kept working. Two builders followed their instructions: try twice, ask, then stop. They waited about 11 hours for a person to fix a key that needed no fixing. Two PRs dropped out of the loop. Their failed jobs became questions nobody answered within 15 minutes, which defaulted to **Take over** and left the PRs for a person.

**Changed:** SSH failures count as network failures. They wait instead of spending attempts, and reach a person only after about 6 hours. Failed jobs are retried after 15, 30, 60 and 90 minutes before a person hears of them. An unanswered infrastructure question defaults to **Continue** twice before **Take over**. Builders retry a failed push with growing waits for at least two hours, and they use `ask_human` for product decisions only.

### Project rules lived in Loop's shared pipeline

The site's own testing and QA rules sat in Loop's shared stage prompts. There they applied to every project and lived outside the site's repository.

**Changed:** the project got its own pipeline in its repository's `.loop-engineering/` folder (`loop init`), reviewed and versioned with its code. Loop's shared stages became generic again.

### Chat gave way to email

Tasks used to come in through a chat bot. Email needs no bot account or webhook, carries attachments, and keeps a task's clarifying questions, plan, agent questions and "it's live" note on one thread.

**Changed:** [email](reference.md#email) is now Loop's built-in channel, with sender authentication, an allowlist and rate limits. The chat channel was removed.

## What we would tell another team

- **Make defaults safe, then let them happen.** Most questions will take their default. Write prompts so that the default is the conservative choice, and read the defaulted decisions in the PRs afterwards.
- **Limit heavy runs, not sessions.** The load came from test and browser runs more than from the number of agents.
- **Expect infrastructure to fail.** Most incidents here involved a process, the network or a disk, not a wrong change. The fixes were about waiting longer, retrying, and telling a person once instead of never or over and over.
- **Run the retro.** All the numbers on this page came from `loop retro` reading the loop's own database.
