# Running Loop unattended

How to run Loop Engineering on one always-on Linux server that a small team sends work to, with nobody watching it. It is written from running Loop on a Debian 13 server (12 CPUs, 31 GB RAM, tmux 3.5a, Node 20); [the case study](case-study.md) has the numbers from its first week. The [reference](reference.md) has every feature in full, and the [README](../README.md) the laptop setup this builds on.

One machine runs everything: the server, the dashboard, the agents in tmux, and the PR loop's jobs. People reach it by email or through the dashboard over SSH. Nothing listens on a public port.

## Contents

- [The machine](#the-machine)
- [Install a release](#install-a-release)
- [Services](#services)
- [The tmux session](#the-tmux-session)
- [Limits on load](#limits-on-load)
- [Temporary files](#temporary-files)
- [When an agent goes away](#when-an-agent-goes-away)
- [Usage limits](#usage-limits)
- [Email](#email)
- [Production Guardian](#production-guardian)
- [Monthly retro](#monthly-retro)
- [Backups](#backups)
- [Upgrades](#upgrades)
- [Reaching the dashboard](#reaching-the-dashboard)
- [What to watch](#what-to-watch)

## The machine

- **A user of its own.** Run Loop as one OS user (say `loop`) that holds only what the agents need: its Claude login, a `gh` login, git credentials for the repos it works on, and the projects' test credentials. Sessions and PR jobs run as this user with its real `HOME`, so they can reach anything it can ([SECURITY.md](../SECURITY.md)).
- **Tools.** Node 20.19 or later, Git 2.31 or later (`git --version`), tmux, [Claude Code](https://docs.claude.com/en/docs/claude-code) logged in as that user, and [`gh`](https://cli.github.com) logged in (`gh auth login`) for the PR loop. `flock` (util-linux) and `pgrep` (procps) for `scripts/heavy`: without `flock` heavy runs have no limit, and without `pgrep` a run stopped at its time limit leaves its browsers running. `sqlite3` for backups. Optional: OpenCode for the free fallback, `jq` for the usage meters, `ttyd` for the terminals under each pipeline. Git's version matters ([below](#what-agents-can-see)):
  - **2.26 to 2.30:** git ignores `GIT_CONFIG_COUNT`, so the runner can no longer override a builder repo's own filters, drivers and credential helpers, and the server logs a warning at start.
  - **Below 2.26** (Ubuntu 20.04 ships 2.25): the runner's git guard can't read config scopes and refuses to run, so no session can start.
- **Git over HTTPS.** `gh auth setup-git` lets git use gh's login, so pushes and the loop's `gh` calls share one credential and one transport. An SSH outage at GitHub then can't stop pushes while the API works. The loop treats SSH failures as network failures and waits them out either way.
- **Size.** What loads the machine is test and browser runs, not sessions: builders and PR jobs each run them. Before the [slot limit](#limits-on-load) existed, the load average reached 56–67 on 12 CPUs and QA jobs ran out of time.

## Install a release

Run a release tag, not `main` ([RELEASING.md](../RELEASING.md)). Do it in a login shell as the Loop user (`sudo -iu loop`, or `ssh loop@server`), so `PATH` includes `~/.local/bin`, where Claude Code's installer puts `claude`:

```sh
git clone https://github.com/lanyado/loop-engineering.git ~/loop-engineering
cd ~/loop-engineering
git checkout v0.1.0          # the latest release: git tag --sort=-v:refname | head -1
npm ci
cp docs/examples/server.env .env
npm run setup                # checks the tools, builds, fills in the tokens and WORKTREES_ROOT
```

The first tag, v0.1.0, is cut once the changes this guide describes are on `main`. Until then there is no tag to check out: use `main` and pin the commit you tested.

Then edit `.env`: the dashboard password and session secret, the email settings if you use email, and the limits. [`docs/examples/server.env`](examples/server.env) lists every variable with the values that suit a server.

Before the first session, as the Loop user:

- Run `claude` once in each project's checkout and once in `WORKTREES_ROOT`, and choose **Yes, I trust this folder** ([folder trust](reference.md#folder-trust-one-time-setup)). A session that meets the prompt anyway asks on the dashboard.
- Register projects with the server running: `npm run add-project -- /home/loop/code/my-app`. Give a project its own pipeline with `npm run loop -- init /home/loop/code/my-app` ([a pipeline per project](reference.md#a-pipeline-per-project)): its rules then live in its own `.loop-engineering/` folder, beside its code, rather than in Loop's shared stages.

## Services

Two systemd user units. Don't run `npm start` under systemd: it is one process for both parts, so a restart of one restarts the other.

`~/.config/systemd/user/loop-server.service`:

```ini
[Unit]
Description=Loop Engineering server

[Service]
WorkingDirectory=%h/loop-engineering
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
Environment=TMPDIR=%h/.cache/loop-tmp
# The database and everything else the server writes: readable by this user only.
UMask=0077
ExecStartPre=/bin/mkdir -p %h/.cache/loop-tmp
ExecStart=/usr/bin/env node apps/server/dist/main.js
Restart=always
RestartSec=5
# Agents run in tmux, started from this service: a restart must leave them alive.
KillMode=process

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/loop-dashboard.service`:

```ini
[Unit]
Description=Loop Engineering dashboard
After=loop-server.service

[Service]
WorkingDirectory=%h/loop-engineering/apps/dashboard
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=LANG=C.UTF-8
Environment=NODE_ENV=production
ExecStart=/usr/bin/env node scripts/serve.mjs start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
loginctl enable-linger "$USER"     # keep the user's services (and tmux) running after you log out
systemctl --user daemon-reload
systemctl --user enable --now loop-server loop-dashboard
journalctl --user -u loop-server -f
```

- **`PATH`** must reach `node`, `git`, `tmux`, `gh` and `claude` (and `opencode`, `ttyd`, `jq` if you use them). Claude's installer puts it in `~/.local/bin`. The server reads everything else from `.env` in the repo root; the dashboard reads its own variables from the same file ([how](reference.md#local-only-operation)).
- **`KillMode=process`** matters. The tmux server the agents run in is started from this unit, so it lives in the unit's cgroup. With the default `KillMode`, every `systemctl --user restart loop-server` (an upgrade, a crash) would kill every builder. With `process`, only the Node process is stopped: builders keep working, and a restarted server finds them again. systemd logs a warning that `KillMode=process` is unsafe; here it is deliberate. The consequences:
  - On a clean stop the server ends its running PR jobs itself, and they start again from scratch after the restart.
  - After a crash or `kill -9`, those jobs' processes keep running, and the restarted loop starts the same job again in the same checkout. Find leftovers by their working folder under `LOOP_JOBS_ROOT` (default `$WORKTREES_ROOT/.loop-jobs`), e.g. `ls -l /proc/*/cwd 2>/dev/null | grep -F /home/loop/loop-worktrees/.loop-jobs`, and stop them.
  - `systemctl --user stop loop-server` doesn't stop the agents. To stop everything, end the sessions first, or `tmux kill-server` after the stop.
- **`UMask=0077`** keeps `data/` (the database holds questions, email threads and history) private to the Loop user. For an existing install, also run `chmod -R go-rwx data`. The tmux server started from this unit inherits the umask too, so files the builders create are private to the Loop user as well.
- **Linger.** Without `loginctl enable-linger`, logging out of the last SSH session stops the user's systemd instance, and Loop and tmux with it.
- **A bad `.env`** makes the server exit with a list of what is wrong, and systemd retries every 5 seconds. Read the log rather than waiting.

## The tmux session

Agents run as windows of the tmux session `loop` on the Loop user's default tmux server. `tmux attach -t loop` shows them; detach with Ctrl-b d. The dashboard's terminals open the same windows.

- Don't `tmux kill-server` or close windows to stop work: end the session (**End session** under its ⋯ on the board, or `POST /api/sessions/:id/end`). A window closed from outside is resumed a minute later, like a crash.
- A reboot kills tmux. When the server comes back, the monitor finds every agent gone, alerts once, and resumes each session ([below](#when-an-agent-goes-away)).
- Keep personal tmux sessions to another user: Loop uses whatever tmux server that user has.

### What agents can see

Agents never inherit the server's environment, which holds all of `.env`. Each agent runs under `env -i` with an allowlist and nothing else:

- the toolchain and locale
- the model login (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` and a few more)
- what pushing and opening PRs needs
- proxies and certificates
- its own session token
- `TAVILY_API_KEY`, `CONTEXT7_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN` and the `LOOP_HEAVY_*` limits

`DASHBOARD_TOKEN`, the shared `MCP_TOKEN`, `EMAIL_APP_PASSWORD` and the dashboard password and secret stay out of their environment and out of tmux's global environment. The full list is in [What agents can see](reference.md#what-agents-can-see).

A variable an agent needs that isn't on the list doesn't reach it, and the agent fails when it looks for it, not at launch. Name extra variables in `.env` with `AGENT_ENV_EXTRA`, comma-separated names or prefixes, such as `AGENT_ENV_EXTRA=AWS_*,OPENROUTER_API_KEY`. The server refuses to start if an entry covers one of its own secrets (`DASHBOARD_TOKEN`, `DASHBOARD_PASSWORD`, `DASHBOARD_SESSION_SECRET`, `MCP_TOKEN`, `EMAIL_APP_PASSWORD`), so those can never be passed through.

The runner's own git commands in builders' repos (`status`, `diff`, `fetch`, `push`, `worktree`), and the PR loop's in its job checkouts of those repos, run with only what pushing needs, with time limits. A command that runs out of time is stopped together with everything it started (a filter, `ssh`, a credential helper). Those commands have no terminal, so git and ssh fail at once instead of asking for a password, a key passphrase or an unknown host key: use an SSH agent or a credential helper, and add the host key to `~/.ssh/known_hosts` first.

- **On every command:** `-c` options turn off hooks, `fsmonitor`, the `ext::` transport, submodule recursion and signature checks, and `GIT_PROXY_COMMAND` is set empty. If you proxy `git://` remotes through a global `core.gitProxy`, the server's own git loses that: the empty `GIT_PROXY_COMMAND` turns every `core.gitProxy` off.
- **The repo's own config:** its filters, diff and merge drivers, pagers, editors, signing programs, `core.sshCommand` and credential helpers are overridden through `GIT_CONFIG_COUNT`, read from where each command runs (a new worktree's checkout runs inside it). The loop's own commits are never signed. Config written in the moment between that read and the command is a known gap. That override needs Git 2.31 or later; Git 2.26 to 2.30 keeps everything else. Below 2.26, git can't list config scopes (`git config --list --show-scope`), so the guard refuses to run: every git command the runner makes fails, and no session can start.

> [!WARNING]
> **This is not a sandbox.** Agents run as the Loop user with its real `HOME`. An agent that goes looking can still read `.env` from the repo folder, read the environment of processes started with the server's full environment (`/proc/<pid>/environ`), and read the other agents' panes. Some practical limits:
>
> - Keep `.env` at mode 0600, which `npm run setup` sets.
> - Send tasks only from people you would give dashboard access.
> - Give the Loop user a fine-grained GitHub token limited to the repos it works on: GitHub access is the biggest credential agents hold.
> - If that is not enough, run the builders as a separate OS user. Loop does not set that up for you.

After upgrading from a release without this, the tmux server that runs your agents keeps the old environment until it exits. The runner removes those names from tmux's global environment at the next session start, but the tmux server process keeps its own copy, and so do agents started before the upgrade. For a full clean, wait until no builder is running, `tmux kill-server`, then resume the sessions ([the reference](reference.md#what-agents-can-see)).

## Limits on load

These settings bound how much runs at once, all in `.env`:

| Variable                                              | Default | What it limits                                                                                                                                             |
| ----------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOOP_MAX_JOBS`                                       | 4       | PR-loop agent jobs (tests, review, QA, custom checks) at once                                                                                              |
| `LOOP_HEAVY_SLOTS`                                    | 3       | Heavy runs at once on the machine: the loop's tests, browser and shell-check jobs, and builders' browser suites and full test runs                         |
| `LOOP_JOB_TIMEOUT_MINUTES`, `LOOP_QA_TIMEOUT_MINUTES` | 30, 15  | One job's run time; the second applies to every job that drives a browser. A job killed at its timeout gets twice the time on its next try, at most 4x     |
| `LOOP_HEAVY_MAX_SECONDS`                              | 7200    | One heavy run of a builder (or yours): then TERM, KILL 30 seconds later, and its slot is free. The loop's own slots are bounded by the job timeout instead |

`scripts/heavy <command>` waits for a free slot and returns the command's exit code. Put the timeout inside it, so waiting doesn't count:

```sh
~/loop-engineering/scripts/heavy timeout 1800 npm test
```

The loop takes a slot for each heavy job before its timeout starts; after 30 minutes without one, the job runs anyway and logs it. Builders are told to use the script (with its absolute path) for browser suites and full QA, and to run long tests under `timeout`, but nothing forces them. Use it yourself for anything heavy you run on the server. Conflict fixes and Production Guardian jobs take no slot, and **the number of sessions building at once has no limit**: if the load stays above the CPU count, lower `LOOP_HEAVY_SLOTS` and send fewer tasks at once.

A test run stuck at 0% CPU (a browser waiting on a dialog, a server that never came up) holds its slot until `LOOP_HEAVY_MAX_SECONDS` in a builder, or until the job timeout in a loop job. A builder idle with undelivered work and a background shell running gets a reminder after 45 minutes that its run may have hung.

## Temporary files

On Debian 13 and some other distributions, `/tmp` is a RAM-backed `tmpfs`, by default half the RAM. Test runs, browsers and Claude Code all write there, so a full `/tmp` also means less memory, and writes start failing. Either:

- Give Loop a temp folder on disk: the server unit above sets `TMPDIR`, which the server, its jobs and the agents all get. Attachments from the dashboard go there too, and are never deleted.
- Or put `/tmp` back on disk: on Debian 13, `sudo systemctl mask tmp.mount` and reboot.

Watch `df -h /tmp` either way: some tools write to `/tmp` whatever `TMPDIR` says.

## When an agent goes away

A builder whose agent exits by itself (a crash, the tmux server dying, a reboot) is paused as `agent_exited` and resumed after 1, then 5, then 15 minutes, at most 3 times in 24 hours. The resumed agent is told its terminal closed, that background commands may have died, and to rerun what it was waiting on. After the third try you get one alert and it stays paused until someone sends it a message. A session with a PR in the loop is resumed by the loop instead, when the PR has feedback for it. Details and every exception: [an agent that went away](reference.md#the-pr-loop).

When several agents go at once, or the tmux server dies, you get one alert naming every session and what happens to each, and each project's history records the dead server's pid and how long it ran: tmux keeps no log of its own.

Other unattended behaviour, all on by default: PRs that stop moving for 2 hours come to you; permission menus nobody answers get Esc after 2 minutes; an agent idle with undelivered work gets reminders after 30 minutes, 2 hours and 6 hours. An agent's question defaults to its recommended option after 15 minutes, so a builder never waits on a person who is asleep. The loop's merge approvals are the exception: they wait for an answer.

## Usage limits

When Claude reaches its usage limit, a builder is paused as `usage_limit` and, with `CLAUDE_LIMIT` empty (`wait`), resumed on Claude every 30 minutes until the limit resets. `CLAUDE_LIMIT=opencode` moves it to the free OpenCode fallback model instead, which keeps going but stalls on long work. PR jobs on Claude move to OpenCode at the limit; an approval from an OpenCode review then waits for a person rather than auto-merging.

To show the 5-hour and weekly limits in the dashboard's top bar, add the capture line from the [README](../README.md#optional-extras) to the Loop user's Claude Code status line script. It is as fresh as the last status line any session drew.

## Email

With email on, people send tasks to the loop's own Gmail or Google Workspace address, answer the agents' questions by reply, and get a mail when their change is in production ([details](reference.md#email)). It reads the mailbox over IMAP and sends over SMTP, so it needs no inbound port.

- **One machine reads the mailbox.** Set `EMAIL_ADDRESS` on exactly one server. Two machines with it set would each read every mail into their own database and answer twice.
- Set `EMAIL_ADDRESS`, `EMAIL_APP_PASSWORD` (an app password of an account only the loop uses), `EMAIL_ALLOWLIST` (exact addresses where you can) and `EMAIL_PROJECT`; `EMAIL_OWNER` routes technical questions and the loop's own decisions to one person. A half-configured channel stops the start with what is missing.
- At most 10 new tasks an hour and 30 mails an hour on one thread; auto-replies and bounces are never answered.
- If you used email as a `local/` add-in before it was built in, remove or rebuild that add-in: the server refuses to start with both.

## Production Guardian

With the PR loop on, the Guardian checks a repo's live site after each deploy and once every 24 hours: API, UI, performance and integrations, each an agent job in a checkout of the deployed code. It runs for repos with a `productionUrl`. Set one through the API (the `repos` array is replaced whole, so send it all back):

```sh
TOKEN=$(grep '^DASHBOARD_TOKEN=' ~/loop-engineering/.env | cut -d= -f2-)
API=http://127.0.0.1:8787/api
curl -s -H "Authorization: Bearer $TOKEN" $API/projects | jq '.projects[] | { id, name }'   # find the id
ID=2   # the project's id from that list
curl -s -H "Authorization: Bearer $TOKEN" $API/projects/$ID \
  | jq '{ repos: [ .project.repos[] | .productionUrl = "https://www.example.com" ] }' \
  | curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d @- $API/projects/$ID
```

A failing area is retried once, and a pass on retry is recorded as flaky. What still fails is diagnosed and sent to a builder as a request, with evidence under `LOOP_JOBS_ROOT/guardian/run<id>/`. A check that could not run is an `error` run, retried after 30 minutes. The jobs sign in only with test accounts from the project's env files, so keep only test credentials there. `"guardian": false` in a project's `pipeline.json` turns it off for that project.

## Monthly retro

`loop retro` turns the database into a Markdown report of the month: sessions, pauses, PRs, fix rounds, time to merge, stage failures, Guardian runs, questions to people and the top recurring problems with evidence ([details](reference.md#monthly-retro-loop-retro)). It reads the database read-only, so it is safe while the server runs. A systemd user timer runs it on the 1st:

`~/.config/systemd/user/loop-retro.service`:

```ini
[Unit]
Description=Loop Engineering monthly retro

[Service]
Type=oneshot
WorkingDirectory=%h/loop-engineering
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
UMask=0077
ExecStart=/usr/bin/env node scripts/loop.mjs retro
```

`~/.config/systemd/user/loop-retro.timer`:

```ini
[Unit]
Description=Loop Engineering monthly retro

[Timer]
OnCalendar=*-*-01 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now loop-retro.timer
```

The report lands in `data/retros/<YYYY-MM>.md`, or `data/retros/<YYYY-MM>-<project>.md` with `--project`. Add `--project <name> --file-request` to `ExecStart` to have that project's builder propose pipeline and prompt changes from its report each month. Try it first with `node scripts/loop.mjs retro --days 7 --stdout`.

## Backups

What is worth keeping, all in the repo folder:

| Path                      | What                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `data/loop.db`            | Everything: projects, sessions, questions, requests, PR states, history, email threads |
| `data/email-alerts.json`  | Owner alerts already mailed                                                            |
| `data/email-attachments/` | Files that came with mailed tasks                                                      |
| `data/stages/`            | The shared pipeline, if you edited it (`STAGES_DIR`)                                   |
| `data/retros/`            | Monthly reports                                                                        |
| `.env`                    | Settings and secrets: keep its backup as private as the file                           |

Projects' own pipelines live in their `.loop-engineering/` folders, in their repos: commit them there. Session work is in git branches and PRs; worktrees under `WORKTREES_ROOT` need no backup.

The database is in WAL mode, so copy it with SQLite's backup command, never with `cp`. A daily timer:

`~/.config/systemd/user/loop-backup.service`:

```ini
[Unit]
Description=Loop Engineering database backup

[Service]
Type=oneshot
WorkingDirectory=%h/loop-engineering
UMask=0077
# systemd needs $$ for $ and %% for %.
ExecStart=/bin/sh -c 'mkdir -p data/backups && sqlite3 data/loop.db ".backup data/backups/loop-$$(date +%%F).db" && find data/backups -name "loop-*.db" -mtime +14 -delete'
```

`~/.config/systemd/user/loop-backup.timer`:

```ini
[Unit]
Description=Loop Engineering database backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now loop-backup.timer
```

It keeps 14 days. Copy `data/` off the machine as well (`rsync`, your backup tool): a backup on the same disk doesn't survive the disk.

To restore, stop everything that opens the database, restore with SQLite itself, and start again. Leave out the timers you didn't install:

```sh
cd ~/loop-engineering
systemctl --user stop loop-server loop-dashboard loop-backup.timer loop-retro.timer
sqlite3 data/loop.db ".restore data/backups/loop-YYYY-MM-DD.db"
systemctl --user start loop-server loop-dashboard loop-backup.timer loop-retro.timer
```

Don't copy the file back instead: after an unclean stop, `loop.db-wal` and `-shm` remain, and SQLite would replay them onto a copied file.

A restore also rewinds the email state (how far the inbox was read, the threads) to the backup. Every mail taken since then is handled again: a task mailed in that window starts a second time.

## Upgrades

Upgrade from one release tag to the next, never by pulling `main`: stop both services, back up the database, `git fetch --tags && git checkout vX.Y.Z`, `npm ci && npm run build`, start. Migrations are one-way, so a rollback needs that backup. The full procedure, with rollback: [RELEASING.md](../RELEASING.md#upgrading-and-rolling-back). Read the release's upgrade notes first, and upgrade when no PR is mid-merge: running PR jobs restart from scratch.

## Reaching the dashboard

The dashboard and server listen on `127.0.0.1` only. Each person forwards the dashboard port, and the terminal ports if they want the terminals, over SSH from their own machine:

```sh
ssh -N -L 3737:127.0.0.1:3737 $(for p in $(seq 3800 3829); do printf -- '-L %s:127.0.0.1:%s ' $p $p; done) loop@server
```

Then open `http://127.0.0.1:3737` and sign in with `DASHBOARD_PASSWORD`. The server's own port (8787) needs no forwarding: the dashboard calls it from the server. Don't put the dashboard behind a public reverse proxy or `ssh -R`: anyone who reaches it can approve merges and start work ([local-only operation](reference.md#local-only-operation)).

## What to watch

The loop asks for a person when it needs one, by dashboard question or by email to `EMAIL_OWNER`. Beyond that:

| Check         | How                                                                                                           | Look for                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Services up   | `systemctl --user status loop-server loop-dashboard`, `curl -s http://127.0.0.1:8787/health`                  | Restart loops, usually a bad `.env` or a stale `local/` build  |
| Server log    | `journalctl --user -u loop-server --since today`                                                              | `[loop]` errors, `[email]` failures, refused starts            |
| PR loop       | `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/loop/status`                             | Jobs running far past their timeout, PRs that don't move       |
| Guardian      | `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/guardian/runs`, or its node on the board | `failed` or `error` runs                                       |
| Agents        | `tmux ls`, `tmux attach -t loop`                                                                              | Windows with a dead pane, an agent at a prompt nothing handles |
| Load          | `uptime` against `nproc`                                                                                      | A load average above the CPU count for long                    |
| Temp and disk | `df -h /tmp ~`, `du -sh $WORKTREES_ROOT ~/loop-engineering/data`                                              | `/tmp` filling; Guardian evidence and attachments add up       |
| Backups       | `ls -l ~/loop-engineering/data/backups`, `systemctl --user list-timers`                                       | A missing day                                                  |
| The month     | `data/retros/<YYYY-MM>.md`                                                                                    | Recurring problems, slow merges, questions nobody answered     |
