# Changelog

Notable changes to Loop Engineering. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in [RELEASING.md](RELEASING.md). Each release is a git tag `vX.Y.Z` with a GitHub release whose notes are that version's section below.

## [Unreleased]

Planned as **0.1.0**, the first tagged release. It will hold everything on `main` since the initial public release on 2026-10-24 (#1 to #37, summarised at the end of this section) and the changes below (#38 to #44).

### Added

- **Automatic resume** of a session whose agent went away by itself (a crash, `/exit`, the tmux server dying): after 1, 5 and 15 minutes, at most 3 times in 24 hours, then one alert and the session stays paused until you message it. Sessions with a PR in the loop stay with the loop, which resumes the builder when the PR has feedback (#39).
- **Dead tmux server detection.** The monitor remembers the tmux server's pid and start time (`tmux-server.json` in the runner's state folder); when it dies or is replaced while it held agents, you get one alert naming every session and what happens to each, and each project's history records how long the server ran (#39, #41).
- **Email as the built-in channel** (`apps/server/src/modules/email`): tasks by mail, clarifying questions and the plan on the same thread, agents' questions answered by reply, owner alerts, and a last mail when the change is in production. Off until `EMAIL_ADDRESS` is set. English by default, Hebrew as a second locale in `i18n.ts` (#40).
- **`loop retro`**: a deterministic, read-only Markdown report mined from the database for a window (sessions, pauses, PRs, fix rounds, time to merge, stage failures, Production Guardian runs, questions to humans, unfinished requests, top recurring problems with evidence). `--file-request` optionally files it as a request for a builder to act on (#42).
- **Pause log**: every pause, change of pause reason and resume is now a `decision` history entry, so time paused can be measured (#42).
- **`scripts/heavy`**, a machine-wide limit on heavy runs (`LOOP_HEAVY_SLOTS`, default 3; `LOOP_HEAVY_MAX_SECONDS`, default 7200). The engine takes a slot for each tests, browser or shell-check job (#38).
- **`POST /api/prs/:id/take-over`** and **`POST /api/prs/:id/retry`**, with a button for each on the PR's lane (#38).
- **Idle-builder and permission-prompt watchdogs**: reminders for an agent idle with undelivered work, Esc for a permission menu nobody answers, and one alert for any screen with no input box for an hour (#38).
- `LOOP_QA_TIMEOUT_MINUTES` (#38).
- Release process: this changelog, [RELEASING.md](RELEASING.md) and an optional release workflow ([docs/examples/release.yml](docs/examples/release.yml)); [docs/unattended.md](docs/unattended.md) for running Loop on an always-on Linux server, with a sample [server .env](docs/examples/server.env); [CONTRIBUTING.md](CONTRIBUTING.md), issue and PR templates; [a case study](docs/case-study.md) of a week of unattended use.

### Changed

- Git over SSH failures (`Permission denied (publickey)`, closed connections, `kex_exchange_identification`) count as network failures: they wait instead of spending attempts, and reach the human after about 6 hours (#38).
- A job whose 3 attempts failed is retried after 15, 30, 60 and 90 minutes before the human hears of it; a job killed at its timeout gets twice the time on its next try, at most 4x (#38).
- An unanswered infrastructure escalation defaults to **Continue** twice per PR, then to **Take over** (#38).
- The runner presses Enter only into an input box that holds the text it typed, never into a dialog (#38).
- Builder instructions: retry a failed push with growing waits for at least two hours, use `ask_human` for product decisions only, run long tests under `timeout` (#38).
- New tmux windows set `remain-on-exit` in the same tmux command that creates them, so an agent that exits at once still leaves its window to inspect; a window whose options fail is killed (#41).
- Auto-resume alerts give the failing command's own output and exit code, cut to fit, and sessions handled in one pass share one alert (#41).

### Removed

- **Telegram.** `settings.telegram_allowlist` is dropped (migration 26) and `PATCH /api/settings` refuses the old key with 400. Questions and requests that came by Telegram keep `telegram` as their channel in history (#40).

### Security

- **Agents no longer inherit the server's environment.** Before, `.env`'s secrets reached every builder through tmux (`DASHBOARD_TOKEN`, the shared `MCP_TOKEN`, `EMAIL_APP_PASSWORD`, the dashboard password and secret). Now each agent runs under `env -i` with an allowlist, tmux itself runs with no credentials, and the secret names are removed from a tmux server that already holds them. It is not a sandbox: agents can still read `.env` from disk as the same user ([What agents can see](docs/reference.md#what-agents-can-see)) (#44).
- Email sender checks: a From header with two addresses is not trusted, the domain is taken after the last `@`, `EMAIL_ALLOWLIST` refuses many more public-provider domains, and a mail that copies the attachments list can only ever list files inside the channel's own folder (#40).
- `nodemailer` 10.3.1 and `mailparser` 3.14.2, past the address-parser advisories of earlier versions (#40).

### Upgrade notes

- **Migration 26 is one-way**, and older code refuses a newer database. Back up `data/loop.db` before the first start of this version (`sqlite3 data/loop.db ".backup data/loop.db.pre-v26"`), as in [RELEASING.md](RELEASING.md#upgrading-and-rolling-back).
- If you ran email as a `local/` add-in, rebuild or remove that add-in first: the server refuses to start with an add-in module named `email`. Only one machine may have `EMAIL_ADDRESS` set.
- Reload open dashboard tabs after upgrading: an old bundle still expects `telegramAllowlist` in settings.
- A tmux server started by an older version still holds `.env`'s secrets in its global environment until the next session start removes them; [the reference](docs/reference.md#what-agents-can-see) says how to clear them at once. A variable an agent needs that is not on `AGENT_ENV_ALLOWLIST` (an OpenCode provider key, say) no longer reaches it.

### Since the initial public release (#1 to #37)

- Stages as files and an editable pipeline, with a pipeline per project (`.loop-engineering/`, `loop init`) (#3, #30).
- Skip a check for one PR, and Run again (#5 to #8, #18).
- The Planner stage: each task is planned first, with clarifying questions, a rigor level and a model per agent (#17, #20, #21).
- Rigor per session, from Fast to Thorough (#12, #15, #20, #27).
- Live terminals under each pipeline, with a fixed port range for SSH tunnels (#26, #35).
- Attachments in prompts (#31).
- The stall alarm for PRs that stop moving, and resuming a builder that can't answer (#32, #33).
- Messages confirmed against Claude's own conversation file (#34, #36).
- Fetch origin before creating a session worktree (#19).
- Plug-and-play setup and the README (#1, #24, #37).

[Unreleased]: https://github.com/lanyado/loop-engineering/commits/main
