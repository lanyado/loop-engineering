# Reference

Everything in detail: each package, the HTTP API, the PR loop, security. For installing and everyday use, start with the [README](../README.md).

- What it does: [SPEC.md](../SPEC.md)
- Build order and milestone status: [PLAN.md](../PLAN.md)
- Rules for agents working in this repo: [CLAUDE.md](../CLAUDE.md)
- Security model: [SECURITY.md](../SECURITY.md) and [Local-only operation](#local-only-operation)

## Layout

npm workspaces, TypeScript (strict, ESM), Node 20.

| Path                 | What                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `packages/core`      | Data model, SQLite store (better-sqlite3, migrations, FTS5 search), clock |
| `packages/runner`    | Session runner: Claude CLI / OpenCode in tmux, worktrees, limit fallback  |
| `packages/ask-human` | `ask_human` MCP tool, question bus, deadline sweeper (M3)                 |
| `packages/router`    | Direct-input routing to marked projects and sessions (M5)                 |
| `packages/loop`      | PR loop engine: tests, review, QA, merge, deploy watch + revert, cleanup  |
| `packages/history`   | Transcript ingest and the `search_history` MCP tool (M8)                  |
| `apps/server`        | Always-on server: `/mcp`, question REST API, SSE events (M3)              |
| `apps/dashboard`     | Next.js dashboard: one board of session pipelines, usage limits (M7, M10) |

## Setup

See the [README quick start](../README.md#quick-start): `npm install`, `npm run setup` (checks the tools, builds, writes `.env` with fresh tokens and `WORKTREES_ROOT`), `npm start` (server and dashboard), `npm run add-project -- <path>`.

## Scripts

```sh
npm run typecheck   # tsc over every package, tests included
npm run lint        # eslint (type-aware) + prettier --check
npm test            # vitest, all packages, in-memory SQLite
npm run build       # tsc -b (packages/*/dist, apps/server/dist), then next build (apps/dashboard)
npm run test:e2e    # build, then Playwright against the dashboard (demo + real server), see below
npm run format      # prettier --write
npm run setup       # check tools, build, write .env (keeps values already set)
npm start           # run the built server and dashboard together (scripts/start.mjs), reading .env
npm run start:server  # the server alone
npm run add-project -- <path> [--name n] [--branch b] [--folder] [--outside-home]  # register a project with the running server
```

Tests resolve `@loop-engineering/*` imports to package sources, so they need no build. CI (`.github/workflows/ci.yml`) runs typecheck, lint, test and build on every PR.

## Using the store

```ts
import { openStore } from '@loop-engineering/core';

const store = openStore({ path: process.env.LOOP_DB_PATH }); // ":memory:" when omitted
const project = store.projects.create({ name: 'shop', repos: [] });
store.history.search('payment retries', { projectId: project.id });
```

Pass `clock: new FakeClock(...)` in tests to control timestamps and question deadlines.

## Server and `ask_human`

`npm run build && npm run start:server` runs the always-on server (Hono on Node; `npm start` runs it with the dashboard). It reads `.env` and resolves a relative `LOOP_DB_PATH` from the repo root, whatever the working directory. Every route except `/health` needs a bearer token:

| Route                                                          | Token                     | What                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                  | none                      | `{ ok: true }`                                                                                                                                                                                                                                              |
| `POST /mcp`                                                    | session token (see below) | MCP Streamable HTTP endpoint with the `ask_human`, `search_history` and `submit_plan` tools                                                                                                                                                                 |
| `GET /api/questions?status=pending&sessionId=`                 | `DASHBOARD_TOKEN`         | `{ questions }`; `status` takes a comma list; pending-only is soonest deadline first                                                                                                                                                                        |
| `GET /api/questions/:id`                                       | `DASHBOARD_TOKEN`         | `{ question }`                                                                                                                                                                                                                                              |
| `POST /api/questions/:id/answer`                               | `DASHBOARD_TOKEN`         | body `{ answer }`, answered via dashboard; 200 `{ accepted, question }`, 409 if already resolved                                                                                                                                                            |
| `GET /api/events`                                              | `DASHBOARD_TOKEN`         | SSE: `ready`, then `question.created` / `question.resolved` / `request.created` as JSON data                                                                                                                                                                |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | `DASHBOARD_TOKEN`         | Projects CRUD, incl. `kind`/`folderPath` (folder projects, below), `autoMerge`, `markedForDirectInput` and `permissionMode`; 409 on a taken name                                                                                                            |
| `GET /api/tree?status=`                                        | `DASHBOARD_TOKEN`         | projects → sessions (with `pendingQuestions`, `rigor`, `rigorSource` and `rigorReason`) → subagents                                                                                                                                                         |
| `GET /api/requests?projectId=N\|none&sessionId=`               | `DASHBOARD_TOKEN`         | `{ requests }`, newest first                                                                                                                                                                                                                                |
| `POST /api/requests`                                           | `DASHBOARD_TOKEN`         | body `{ text, projectId? }`: a new task from the dashboard; no project leaves it to the router. `{ text, sessionId }`: a message for one open session (409 once ended)                                                                                      |
| `GET /api/usage`                                               | `DASHBOARD_TOKEN`         | `{ usage }`: Claude Code's 5-hour and weekly limits (`usedPercentage`, `resetsAt`) from the status line snapshot, or null                                                                                                                                   |
| `GET /api/prs?projectId=&stage=&open=`, `GET /api/prs/:id`     | `DASHBOARD_TOKEN`         | PRs with stage, round, linked request and metrics, most recently moved first                                                                                                                                                                                |
| `GET /api/metrics?projectId=`, `GET /api/prs/:id/metrics`      | `DASHBOARD_TOKEN`         | per-PR loop metrics (cost, tokens, rounds, failures) and totals                                                                                                                                                                                             |
| `GET/PATCH /api/settings`                                      | `DASHBOARD_TOKEN`         | session and fallback model, backup OpenCode models, the Claude Code / OpenCode switches, a channel allowlist                                                                                                                                                |
| `GET/PUT /api/pipeline`                                        | `DASHBOARD_TOKEN`         | the PR loop's pipeline and stages (stage files), ; PUT writes `STAGES_DIR` (validated first; 400 on an unknown stage, a bad id or setting)                                                                                                                  |
| `PATCH /api/sessions/:id`                                      | `DASHBOARD_TOKEN`         | body `{ rigor }` (`fast`, `light`, `standard`, `thorough`): the session's [rigor](#rigor-per-session) (this pins it: the Planner no longer changes it) -> `{ session }`; 400 on another value or key, 404 unknown session, 409 for the router's own session |

Each session authenticates with its own token, `HMAC-SHA256(MCP_TOKEN, "session:<id>")` in hex (`sessionToken()` in `@loop-engineering/core`). `/mcp` accepts a request only when the bearer is the token of the session named in `X-Loop-Session-Id` (compared in constant time), so an agent cannot ask, answer or search history as another session. Tokens of sessions that do not exist or have ended are refused. The runner puts only that derived token in the agent's environment (as `MCP_TOKEN`), never the shared secret. For manual testing, `MCP_ALLOW_SHARED_TOKEN=on` also accepts the raw `MCP_TOKEN`; it is off by default, the server logs a loud warning at start when it is on, and it refuses to start with it under `NODE_ENV=production`. Point a session at the tool by hand, e.g. for Claude Code:

```sh
TOKEN=$(node -e 'const c=require("crypto");console.log(c.createHmac("sha256",process.env.MCP_TOKEN).update("session:"+process.argv[1]).digest("hex"))' <session id>)
claude mcp add --transport http ask-human "$SERVER_URL/mcp" \
  --header "Authorization: Bearer $TOKEN" --header "X-Loop-Session-Id: <session id>"
```

`ask_human({ question, options, recommended, context?, subagentId?, sessionId? })` takes its session from the connection's `X-Loop-Session-Id` header, which the runner always sets. The header is required; a `sessionId` argument may only confirm it, and one that disagrees is refused. Sizes are capped: question 3000 characters, at most 10 options of 200, context 2000, answers 2000. A full question can still exceed what a channel shows at once, so channels split or truncate for display. It blocks until the first answer from the dashboard or another channel that is set up, or for 15 minutes, and returns `{ questionId, answer, answeredVia, defaulted, note }`. On a default the answer is the recommended option and the note tells the agent to say so in its work. If an MCP client caps how long a tool call may take, raise the cap above 15 minutes (for Claude Code, `MCP_TOOL_TIMEOUT` in milliseconds). While waiting, the tool sends a progress notification every 25 s to clients that asked for progress.

Restarts: pending questions live in SQLite, and on start the sweeper defaults any that came due while the server was down, then keeps defaulting the rest on time. A caller blocked in `ask_human` loses its HTTP connection when the server stops, and its tool call fails. If the agent asks the same question again (same session, subagent, text and options) while it is still pending, it re-attaches to it. If the question was answered or defaulted while no caller was waiting (the agent was disconnected) and less than 15 minutes ago, the re-ask gets that outcome once, with a note saying it was settled while the agent was away. An outcome the agent already received is never reused: asking the same question again asks the human anew. A caller that disconnects stops waiting, but its question stays open for the human.

Channels plug into the question bus (`@loop-engineering/ask-human`). `attachChannel(bus, channel)` calls `onQuestion` for each new question, and `onResolvedElsewhere(event, "answered: X (via dashboard)")` when another channel or the timeout settled a question first. A channel answers with `questions.answer(id, text, <its name>)`. New features join the server as `ServerModule`s (`apps/server/src/context.ts`): `api()` adds routes under the authenticated `/api`, `routes()` adds root routes that do their own auth, and `start()`/`stop()` run workers.

## Local add-ins

Channels or integrations you keep to yourself live in a `local/` folder at the repo root, which git ignores. It is its own small package (its own `package.json`, dependencies and build) and resolves this repo's packages (`@loop-engineering/core`, `@loop-engineering/ask-human`, `@loop-engineering/router`, the server's types from `@loop-engineering/server`) from the root `node_modules`. At start the server imports `local/dist/index.js` if it exists:

```ts
import type { ServerModule } from '@loop-engineering/server';

export function serverModules(env: NodeJS.ProcessEnv): ServerModule[] {
  return [myChannel(env)]; // read your own settings from .env
}
```

Each module is a `ServerModule` like the built-in ones (routes, MCP tools, `start`/`stop` with the `ServerContext`). A question channel subscribes to the question bus with `attachChannel` (`packages/ask-human`); new tasks go through `ctx.requests.create`, so the router takes them like any other. The modules start after the dashboard API and before the router. An add-in that throws an error whose name ends in `ConfigError` stops the start with its message, like the server's own settings. The add-in builds against the public packages' types, so build in this order: the repo's `npm run build`, then `npm --prefix local install` and `npm --prefix local run build`. `npm run build` never rebuilds `local/`, so rebuild it after pulling updates. Without `local/dist/index.js` the server runs without add-ins and logs that the folder is not built; a build that fails to load stops the start and says how to rebuild. `local/` must be a real folder, not a symlink: Node resolves modules from the real path, so a symlinked add-in would not find the repo's `node_modules`.

## Requests and the router

Every task the human sends goes through one call, `ctx.requests.create(input)` (`RequestService` in `@loop-engineering/ask-human`). It stores the Request and emits `request.created` on the server's bus (and the dashboard's SSE stream). Add-in channels, the dashboard's task form and the PR loop all use it. Calling `store.requests.create` directly skips the event, so the router never hears about the task.

The router (`packages/router`, the `routerModule` in `apps/server/src/modules/router.ts`) is the only thing that starts sessions for requests:

- **A request that names its project** (a dashboard task with a project, a PR-loop fix request) gets a new session in that project, with no classifier call. The project does not have to be marked for direct input: naming it is an explicit choice. A request naming the router's reserved project (below) is refused.
- **Any other request** is classified among the projects marked for direct input with one cheap headless call: `claude -p --model haiku --output-format json --tools "" --strict-mcp-config --no-session-persistence --safe-mode --disable-slash-commands`, run from a temp folder. That is no tools, no MCP servers, and no CLAUDE.md, skills, plugins or hooks. `settings.json` and Claude Code's built-in system prompt still load, since `--bare` would also turn off the subscription login. While Claude is out of usage, it uses `opencode run --format json -m <Settings fallback model>` instead.
  - The classifier sees each marked project's name, kind (`git` or `folder`), folder name (for a folder project, the last path segment only), repos, latest request titles and open sessions (title, branch, status). The task text sits between markers with a random per-call tag.
  - It answers `{ projectId | null, target: { kind: 'session', sessionId } | { kind: 'new' }, confidence, candidates }`.
  - Invalid JSON, unknown or ineligible ids, a timeout (60 s) or a failure count as unclear.
- **Confident** (confidence ≥ 0.75):
  - An open session gets the request through the runner's `deliverFile`: the text is written to `<agent cwd>/.loop/request-<id>.md` and the agent receives only one fixed sentence pointing at it.
  - Otherwise a new session is started with `startSession(projectId, { requestId })`.
  - If the open session cannot take it (paused, agent gone, ended), a new session in the same project gets it instead.
- **Unclear**: the human is asked through the question bus, with options like `shop: new session`, `shop: session 'fix login' (#12)` and `Cancel` (at most 10).
  - The recommended option, which is taken after 15 minutes, is the classifier's top candidate when it proposed one, and **Cancel** otherwise. So an unanswered question about a request nobody could place never starts a session.
  - A free-text reply naming a project means a new session there.
  - An answer that matches nothing is asked once more (Cancel recommended), then the request is left alone.
- **No projects marked**: requests without a project are retried every 5 minutes, so marking a project picks them up without a restart.
- Each routing decision is a `decision` history entry in the project, so it is searchable. A new session's entry is written once the launch worked; a failed start gets its own entry. Cancelled or abandoned requests get one in the reserved project.
- **Restarts and idempotency.** A request is routed once it has a session.
  - On start, every request without a session is routed, at most 2 classifications or launches at a time. Waiting for a human holds no slot.
  - A routing question left pending is re-attached, not asked again. One answered while the server was down is applied.
  - Cancelled and abandoned requests are skipped.
  - A hard crash between a session's launch and its link to the request can lead to a second session on restart. That duplicate is visible and better than a request silently lost; cleaning up half-started sessions is the runner's job.
  - Concurrent triggers for one request share one run.
- **Routing questions** belong to a reserved project and session, `Direct input (router)` / `Routing questions`, because a question needs a session in core.
  - It is created ended and unmarked on the first question. Its id is stored in `settings.router_session_id`.
  - Each question is linked to its request through `questions.request_id`; its `context` is plain text for the human.
  - The dashboard API hides the reserved project and refuses tasks, edits and deletes for it.

The module uses the server's shared runner (`ctx.runner`: `startSession` and `deliverFile`). It never builds its own runner. Without one it logs `[router] disabled` and requests wait.

## Running sessions

```ts
import {
  DefaultAgentCli,
  nodeFs,
  RealGitDriver,
  RealTmuxDriver,
  SessionRunner,
  UsageLimitMonitor,
} from '@loop-engineering/runner';

const runner = new SessionRunner(
  {
    store,
    tmux: new RealTmuxDriver(),
    git: new RealGitDriver(),
    fs: nodeFs,
    agentCli: new DefaultAgentCli(),
  },
  { worktreesRoot: process.env.WORKTREES_ROOT!, serverUrl: process.env.SERVER_URL! }, // token from MCP_TOKEN
);
new UsageLimitMonitor(runner, store, { onTrustPrompt }).start(); // every 15 s: dead agents, trust prompt, usage limit -> OpenCode
const session = await runner.startSession(project.id, { text: 'Add a login page' });
```

- Each session gets a branch `loop/<slug>-<id>` and a worktree per repo under `WORKTREES_ROOT/<project>/`. Before creating each worktree the runner runs `git fetch origin <defaultBranch>` in the repo's checkout (30 s timeout) and branches from `origin/<defaultBranch>` with `--no-track`, so a stale local branch never leaks into a new session. If the fetch fails (offline, no remote, auth) it logs one warning and branches from the local default branch instead.
- The project's env files and the `opensource-search` skill are written into the worktree, unless the repo tracks that path (then they are skipped with a warning). Both are hidden from `git status` via `info/exclude`.
- The MCP config (ask_human, tavily, playwright, context7, github) and the OpenCode config are written to `WORKTREES_ROOT/.loop-runner/s<id>/`, never into the repo. A repo's own `.mcp.json` servers are copied in.
- The model comes from Settings (`sessionModel`, default `opus`), and the permission mode from the project (`permissionMode`, default `auto`).
- Agents run in windows of the tmux session `loop` (`tmux attach -t loop`).

#### What a session is told

Every agent gets standing rules from `packages/runner/src/instructions.ts`: Claude through `--append-system-prompt` (so they survive compaction and cover every later message: routed requests and PR feedback in `.loop/` files), OpenCode at the top of its first message (it has no system-prompt flag). The request text is only the first user message and never becomes part of the rules.

- **Nobody reads the terminal.** Questions go through the `ask_human` tool (options plus a recommended one), never plain text. An ambiguous request with a sensible default goes ahead on the default, noted in the PR or summary.
- **Planning first.** Each new task (not PR feedback or review fixes) starts with a plan, before any change, following the Planner's instructions (`planner.md`, a stage file: built in, or yours in `STAGES_DIR`, editable on the Planner node in `/edit`): read the code the request touches, ask with `ask_human` when something is unclear or a real product choice (a few questions, all at once), else go with sensible defaults; then a short plan (goal, approach, files, tests, risks). The agent records it with the `submit_plan({ plan, rigor?, rigorReason? })` MCP tool (plan 1 to 8,000 characters; the session comes from the connection's `X-Loop-Session-Id`, like `search_history`), which stores it on the session (`sessions.plan`, `planned_at`, migration 22; a later plan replaces it) and emits `session.planned` on the SSE stream, then builds it. `rigor` (`fast`, `light`, `standard` or `thorough`) is the agent's judgement of the [rigor level](#rigor-per-session) for the work, `rigorReason` one sentence (200 characters at most) on why; both are optional in the schema so older prompts keep working, but the instructions ask for them. A level that is not one of the four is refused. The level applies only while the human has not chosen one. Planning is a phase of the same agent, not another one: same context, no extra cost. The instructions are read at each launch and resume, so an edit reaches sessions from their next start.
- **Git project:** do the task, run the repo's quick tests or lint, commit, `git push -u origin <branch>`, `gh pr create --base <default branch> --head <branch>` (body: what changed, why, the request), then stop. The PR loop picks the PR up from the branch. Never merge, push to the default branch, delete branches or touch anything outside the task. No change needed: say so, no PR.
- **Folder project:** edit in place and stop with a short summary. No commit, push or PR, even if the folder is a git repo.

#### Folder trust (one-time setup)

Claude shows "Is this a project you created or one you trust?" before it starts in a folder it does not trust, and an unattended session would wait there forever. Measured with Claude Code 2.1.302 (fake `HOME`, throwaway repos):

- **A git worktree inherits trust from its repo's main checkout**, and accepting the prompt in a worktree saves trust for that main checkout. So run `claude` once in each registered repo's checkout (`repos[].path`) and choose "Yes, I trust this folder": every session worktree of that repo then starts without the prompt.
- **A folder that is not in git inherits trust from any trusted parent.** Multi-repo sessions run in the (non-git) folder holding their worktrees, so also run `claude` once in `WORKTREES_ROOT` and accept. Trusting `WORKTREES_ROOT` alone does **not** cover single-repo sessions: inside a git repo the parent search stops at the repo root.
- Folder projects: run `claude` once in the folder.

There is no CLI flag or documented setting that trusts folders for you (only `-p`, which skips the dialog, and the runner runs interactive sessions), and the runner never edits `~/.claude.json` or answers the dialog itself. Instead the monitor watches for it: a session stuck at the trust prompt becomes a question on the dashboard ("Session N is waiting at Claude's "Do you trust this folder?" prompt for <path>"), with the exact `tmux attach -t loop:@<window>` command. Attach, choose "Yes, I trust this folder" if you do, and detach with Ctrl-b d. Detection reads everything below the dialog's top rule, so it works at any window width (tested on real captures at 40 to 120 columns). Window sizes are not pinned, so the dialog stays readable from a small client such as a phone.

### Folder projects

A project is `kind: 'git'` (the default: repos, a branch and worktree per session, PRs through the loop) or `kind: 'folder'`: one plain folder, such as `~/resume` or `~/notes`, that needs no git and no remote.

`npm run add-project -- ~/notes --folder` registers one (`apps/server/src/add-project-cli.ts`; without `--folder`, a path inside a git repo with an `origin` remote becomes a git project with that repo, its remote and default branch). The same through the API:

```bash
curl -X POST http://127.0.0.1:8787/api/projects -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"resume","kind":"folder","folderPath":"/Users/me/resume","markedForDirectInput":true}'
```

- **The agent edits the real files in place.** There is no branch, worktree or PR, so there is nothing to throw away if a session goes wrong. Keep a backup of the folder (Time Machine, a copy), or `git init` it and commit before you send a task.
- **One session at a time.** A folder project has at most one active or paused session, since two agents editing the same files would collide. A second start fails with `FolderBusyError` ("folder busy"). This rule is enforced inside the server's one runner process (the check and the insert run with no `await` between them), not by a database constraint: a second process starting sessions on the same database could break it.
- **A new request for a busy folder goes to its open session.** The router asks the runner what that session can do:
  - Live agent: the request is handed to it as a `.loop/` file.
  - Paused for the usage limit: it is resumed, with the request named in its first prompt.
  - Paused by you: the router never undoes that on its own. It asks you to "Resume it and deliver", "End it and start fresh" or "Cancel". Cancel is the 15-minute default, and it drops the request.
  - Agent gone (exited, window closed, never finished starting): the session is ended, which leaves the files alone, and a new session starts.
  - A lost start race is retried at once.
  - After 4 failed rounds the human gets one routing question: new session, the open session, or Cancel. Cancel is the 15-minute default, and it drops the request. So a request never waits silently.
  - Waiting for any of these answers holds none of the router's work slots, so other requests keep routing meanwhile.
- **Ending sessions.** `POST /api/sessions/:id/end` (dashboard token) and the **End session** button in each open session's details on the board (⋯, with a confirm step) end any session through the runner. A git session with uncommitted changes is still refused, unless the API body says `{ "force": true }`. The runner's monitor also ends a folder session whose agent is gone, instead of pausing it, so the folder never stays blocked by a dead session.
- **What the runner writes in the folder:** only `.loop/` (request and feedback files from `deliverFile`, plus `.loop/.gitignore` containing `*`, because the folder may have no git exclude). The MCP config, OpenCode config and launch script stay in `WORKTREES_ROOT/.loop-runner/s<id>/`. No `.mcp.json`, `.claude/` or skill is written into the folder, and no env files are copied (folder projects have none).
- **`end()` never deletes or moves anything in the folder.** It stops the agent and removes the runner state; `.loop/` stays.
- **The PR loop ignores folder projects** (no branch discovery, merge or cleanup). `autoMerge` is accepted by the API but does nothing, and the dashboard shows it as "n/a (no PRs)".
- **Checks when it is created** (`POST /api/projects`):
  - The folder must exist, be a folder, and have no `#` in its path.
  - Allowlist: the folder must be inside your home folder, with no dot-folder anywhere in its path (`~/.local`, `~/.docker` and so on hold tools and credentials), and not inside `~/Library` or `~/Applications`.
  - A folder outside home needs `"allowOutsideHome": true`. Even then it may not overlap a system folder (`/usr`, `/opt`, `/etc`, `/private`, `/var`, `/Applications`, `/System`, `/Library`, `/bin`, `/sbin`), or be `/Volumes` or a whole mounted disk.
  - The folder may not overlap any folder on the server's `PATH`, or the real folders holding the `claude`, `opencode`, `gh`, `tmux`, `node` or `git` binaries. An agent there could rewrite what the server launches.
  - It may not be `/`, your home folder itself, or overlap `~/.claude` (or `CLAUDE_CONFIG_DIR`), `~/.ssh`, `~/.config`, `~/Library`, `~/.gnupg` or `~/.aws`. An agent editing in place there could rewrite its own permissions or reach credentials.
  - It may not overlap `WORKTREES_ROOT`, the runner state folder, `LOOP_JOBS_ROOT`, the server's own repository (it holds `.env`), the database folder, or another project's folder or repo.
  - A folder that is, or is inside, a git work tree is refused (register the repo as a git project) unless you pass `"allowGitFolder": true`.
  - Every comparison uses the canonical path (`realpath.native`: symlinks resolved, and the letter case the disk stores, since macOS disks are case-insensitive). That canonical path is what gets stored.
  - The other direction is checked too: a git project's repo may not overlap a folder project's folder, on create or on PATCH.
  - `kind` and `folderPath` cannot be changed later.
  - Before every launch, resume and delivery, the runner checks that the folder still resolves to exactly the stored path. If it was replaced by a symlink or renamed, the session is refused.
- Claude asks for folder trust once per folder: run `claude` once in the folder and accept the prompt before the first session (see "Folder trust" above).

## Dashboard (`apps/dashboard`)

Next.js 16 (App Router), built for a computer screen (from 1280px wide). One screen, no tabs:

- **Top bar:** the **Claude** mark beside Claude Code's **5-hour** and **weekly** limits (percent used, time to reset; amber from 70%, red from 90%) and the settings shared by every project (the **Claude Code** and **OpenCode** switches, session and fallback model, backup OpenCode models). There is no "+ New session" button here: a new session starts from **+ Session** on a project. With both switches on, sessions run on Claude Code and move to OpenCode on a usage limit. Backup OpenCode models are what an OpenCode session moves down the moment its model stops (limit, error, hang), in order, before the fallback model. With one switch on, only that one is used: OpenCode-only sessions run on the fallback model, and Claude-only sessions wait out a usage limit. The last switch on can't be turned off. A session already running keeps its CLI until it next pauses; when it resumes, it moves to the CLI that is on (with a fresh conversation that gets the full state).
- **The board:** every project, those waiting on you first. In each, every live session is a pipeline read left to right, n8n style: **Planner → Builder → Tests → Code review → QA → Approval → Merge → Deploy → end**. The Planner is "planning" while the session is open with no plan, or with a plan older than its newest task (a session with no plan that opened a PR already counts as past it), then "planned"; the Builder waits ("not yet") while it plans. The Planner node has the **+** and **⋯** buttons; the terminal (**>\_**) is on the Builder. The PR stages repeat as one lane per open PR, so a session with two PRs splits into two lanes. A node shows its state in words and colour (done, running, not yet, failed, stopped, waiting on you).
- **The rigor dial** sits at the top right of each git session's pipeline: Fast, Light, Standard, Thorough on a track from warm to green, with "Faster · cheaper ←→ Safer · thorough" under it and one line on what the chosen level does. A radio group (arrow keys move and choose); a choice is saved at once and pins the level against the Planner ([Rigor per session](#rigor-per-session)). Every level draws every stage. When the Planner chose the level, its reason is on the chosen level's tooltip and in the Plan section of the Planner node's details ("Rigor set by the Planner: …"; "Rigor set by you" after your own choice). Read-only in demo mode, inert in the editor.
- **Questions on their node:** an agent's `ask_human` question is on the Planner node when it was asked since the newest task came and before its plan (or while it still plans), else on the Builder node (with the subagent's name), and the PR loop's questions on the node that asks: approval on Approval, a deploy timeout or failed revert on Deploy, an escalation on the lane's end. The cards (one-tap options, free text, default and countdown) sit right under the pipeline. Questions no row shows (routing questions) are listed at the top.
- **+ on a session** sends it a message: the router delivers it into that session (or, if it has ended since, to a new session in its project). **⋯** shows its plan, what runs it, its subagents and **End session**. **+ Session** on a project starts a new session there; its slider icon opens that project's settings (auto-merge, direct input, permission mode). Finished sessions fold into **Finished (N)**.
- **The pencil** (`/edit`) edits the dashboard on one example project, like iOS's Control Center: what can change wiggles where it sits, **−** removes it, and it stays faded in place with a **+** that brings it back; dragging or the arrows reorders. It covers the top bar items, the row details, and the pipeline on the example's own lane (the checks' order, removing or adding stages, each stage's prompt and settings, a faded "New stage" tile, Deploy and Guardian, and the Planner's instructions on its node). **Discard** and **Save** each ask first when something changed; Save sends the pipeline to `PUT /api/pipeline` (stage files) and the layout to `PATCH /api/settings` (`dashboardLayout`, which `src/lib/layout.ts` defines). Project order and hiding live on the real board, in each project's slider panel.
- The old pages (`/tree`, `/prs`, `/metrics`, `/settings`, `/new`) redirect to the board.

**Usage limits.** Claude Code gives its status line command the account's rate limits. Add one line to your status line script so the server can read them (it never reads your login token):

```sh
printf '%s' "$input" | ~/loop-engineering/scripts/capture-claude-usage.sh   # $input: the status line JSON
```

The snapshot goes to `~/.local/state/loop-engineering/claude-usage.json` (`CLAUDE_USAGE_FILE`). It is as fresh as the last status line render of any Claude Code session; the top bar says "as of …" when it is over 30 minutes old, and "not captured yet" before the first one.

- **Secrets stay on the server.** The dashboard's own server calls the API with `SERVER_URL` + `DASHBOARD_TOKEN` (pages are server components; writes are Server Actions). The browser gets live updates from `/api/events`, a same-origin relay of the server's SSE stream, which passes the same access check as the pages.
- **Access (`DASHBOARD_AUTH`):** `none` (the default, allowed only while `DASHBOARD_HOST` is loopback) has no login page and no cookie; see "Local-only operation" for the Host/Origin checks that protect it. `password` keeps the login below; any non-loopback `DASHBOARD_HOST` (and Vercel) requires it, and the dashboard refuses to start otherwise.
- **Login (`DASHBOARD_AUTH=password`):** `DASHBOARD_PASSWORD` (12+ characters) buys a signed httpOnly cookie (HMAC-SHA256 keyed by `DASHBOARD_SESSION_SECRET`, 30 days; the secret is required in production, and rotating it signs everyone out). The password check runs through PBKDF2; failed logins are delayed, an IP is locked out for 15 minutes after 5 failures, and every login after 10 failures from anywhere (in memory, so per instance on Vercel). The proxy (`src/proxy.ts`) sends logged-out requests to `/login`, and every page and action checks again: data comes only from `backendForViewer()`, and eslint refuses the unchecked getter in `src/app` and `src/components`.
- **Limits on what the dashboard can change:** it cannot set a project's `permissionMode` to `bypassPermissions` (the API answers 400; only a local path may set it), and `DELETE /api/projects/:id` is refused (409) while the project has a session that isn't ended or an open PR.
- **Demo mode:** with no `SERVER_URL`, the dashboard serves realistic fixture data, labelled "Demo data" and read-only. That is how a Vercel preview runs before the always-on server exists.

```sh
npm run dev -w @loop-engineering/dashboard                                                 # demo mode, no login
SERVER_URL=http://127.0.0.1:8787 DASHBOARD_TOKEN=... npm run dev -w @loop-engineering/dashboard
DASHBOARD_AUTH=password DASHBOARD_PASSWORD=... npm run dev -w @loop-engineering/dashboard    # with the login
```

Tests: `npm test` runs the dashboard's unit tests with everything else (auth tokens, formatting, demo fixtures, and a contract test running the dashboard's API client and response schemas against the real server routes). `npm run test:e2e` builds, then runs Playwright (`apps/dashboard/e2e`) at desktop width, against a demo-mode dashboard and against a dashboard wired to a real server on a temp SQLite file (both with no login), plus a demo dashboard in `password` mode for the login path, including a real MCP client calling `ask_human` and getting the answer tapped in the dashboard. It needs Playwright's Chromium (`npx playwright install chromium`, already cached on the dev Mac); it is not part of CI. It runs with exactly one worker: the live projects share one server and database and reset it before each test.

Because the e2e suite is not in CI, run `npm run test:e2e` before merging any change that touches auth (`/mcp` or `/api` tokens, the session token, login).

## Local-only operation

> **No-login mode assumes nothing forwards traffic to `127.0.0.1`.** Do not expose the dashboard through an SSH tunnel (`ssh -R`), `socat`, `tailscale serve`, a reverse proxy or similar while `DASHBOARD_AUTH=none`: anyone who can reach the forwarded port can answer approval questions and send tasks. If you want remote access, switch to `DASHBOARD_AUTH=password` first.

For now the server and dashboard are reachable from this machine only.

| Part      | Address                 | Set by                                                 |
| --------- | ----------------------- | ------------------------------------------------------ |
| Server    | `http://127.0.0.1:8787` | `SERVER_HOST` (default 127.0.0.1), `SERVER_PORT`       |
| Dashboard | `http://127.0.0.1:3737` | `DASHBOARD_HOST` (default 127.0.0.1), `DASHBOARD_PORT` |

Start both with `npm start` (after `npm run build`), or each on its own: `npm run start:server` and `npm run start -w @loop-engineering/dashboard` (`npm run dev -w ...` for development).

- The dashboard reaches the server through `SERVER_URL=http://127.0.0.1:8787` (match `SERVER_PORT`) with `DASHBOARD_TOKEN`. `scripts/serve.mjs` reads both, and the other `DASHBOARD_*` variables, from the root `.env` (the shell wins, then `apps/dashboard/.env.local`, then the root `.env`, whose empty values are skipped); nothing else from that file reaches the dashboard. With no `SERVER_URL` (e.g. `SERVER_URL= npm run dev -w @loop-engineering/dashboard`) it runs in demo mode.
- **No login by default.** On a loopback `DASHBOARD_HOST` (`127.0.0.1`, `localhost`, `::1`), `DASHBOARD_AUTH` defaults to `none`: no password, no login page (`/login` redirects to `/`), no cookie. `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET` are only needed with `DASHBOARD_AUTH=password`, which keeps the full login (PBKDF2, lockouts, signed cookie). The browser still never sees `DASHBOARD_TOKEN`, and the server's `/api` still requires it.
- Because any website you visit can make your browser send requests to `127.0.0.1`, `none` mode answers only requests whose `Host` is exactly `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (403 otherwise: this blocks DNS rebinding), and every non-GET request and Server Action must carry a matching `Origin` (or `Sec-Fetch-Site: same-origin`), else 403 (this blocks CSRF). The proxy checks this for pages, `/api/events` and actions, and pages and actions check it again. Every response sends `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and `Referrer-Policy: no-referrer`.
- **The loopback bind is what keeps other machines out in `none` mode** (a non-browser client can forge `Host` and `Origin`). `npm run dev|start` go through `apps/dashboard/scripts/serve.mjs`, which checks `DASHBOARD_HOST`/`DASHBOARD_AUTH` before Next starts (one line and exit 1 when refused) and then runs `next -H $DASHBOARD_HOST -p $DASHBOARD_PORT`; it refuses `-H`/`-p` passed through npm. Started any other way (`npx next start -H 0.0.0.0`, a bare `next start`, `HOSTNAME=0.0.0.0`), `src/instrumentation.ts` judges the socket the server really bound and exits when `none` mode is not loopback-only. Next does not expose a request's peer address to the proxy or route handlers, so there is no per-request peer check; `x-forwarded-for` is never trusted.
- **Warning:** setting `DASHBOARD_HOST` to anything but loopback (`0.0.0.0`, a LAN address) exposes the dashboard to the network. The dashboard then refuses to start unless `DASHBOARD_AUTH=password` with `DASHBOARD_PASSWORD` and a 32+ character `DASHBOARD_SESSION_SECRET`. The same applies on Vercel.
- The server refuses to start with a non-loopback `SERVER_HOST` unless `ALLOW_NON_LOCAL_BIND=on`; with it, it starts with a loud warning.
- CORS: with `CORS_ORIGINS` empty, `/api/*` allows only `http://127.0.0.1:<DASHBOARD_PORT>` and `http://localhost:<DASHBOARD_PORT>` (`DASHBOARD_PORT` default 3737).
- In `password` mode, the login cookie is `Secure` only over https (or `x-forwarded-proto: https`), so login works on `http://localhost`.

## The PR loop

`packages/loop` takes every PR a session opens through tests, review, QA, merge, deploy and cleanup. The server runs it when `LOOP_ENGINE=on` (see `.env.example`), on the server's one `SessionRunner` (`ctx.runner`, created when `WORKTREES_ROOT` is set, with the one usage-limit monitor); `GET /api/loop/status` (DASHBOARD_TOKEN) shows running jobs and the PRs in the loop.

- **The pipeline is files.** Which checks a PR goes through before merge, in what order, and what each one checks come from stage files: the built-ins in `packages/loop/stages/`, overridden or extended by yours in `STAGES_DIR` (default `data/stages/`). The format and the rules are in [packages/loop/stages/README.md](../packages/loop/stages/README.md). The loop rereads them on every step, so an edit reaches PRs already in the loop: a check added runs before merge in the same round, and a removed one is skipped. `LOOP_CHECK_PROVIDER` picks the CLI for custom stages (default claude).
- **Skipping a check for one PR.** On the board, a check node of a PR still in the loop has **Skip**; a pop-up says what happens and asks first. The loop then counts that check as passed for that PR at every head, until **Run again** brings it back (`POST /api/prs/:id/skip { check, skip }`, `loopState.skip`). A send-back of that check still waiting for the builder is dropped. CI still gates the merge, and with the code review skipped the merge waits for your approval. It is recorded in the history, and works with the loop off. The node flips the moment you confirm and the save runs in the background; a save that fails flips it back and reopens the pop-up with the error. A running loop steps that PR at once, without discovery (`LoopEngine.pokePr`): a job of the skipped check still running is stopped without spending an attempt or posting anything, and the PR moves on; a check brought back starts right away. If the PR's step is busy, it is stepped again as soon as that step ends.
- **Rigor, per session.** See [Rigor per session](#rigor-per-session) below: one dial per session that decides how much of the pipeline its PRs get.
- **Discovery.** Each tick (30 s) the loop asks `gh` for a PR on the branch of every active or paused session. It tracks it only if the head is in the same repo (not a fork), on the session's branch, and its commit is on the session's local branch. Nothing else is needed to hand it work: once the router starts a session, its PR enters the loop when the agent opens it. `engine.track(sessionId, repo, number)` adds one at once.
- **Tests.** CI checks must not fail or be cancelled, and in the default pipeline tests are the first stage: the builder writes tests for its change as part of building (its instructions say so), pushes them with the code, and a tester job runs that test suite at the PR head (plus typecheck) before review ever sees it. The tester may write missing tests in its checkout; the loop commits and pushes those (the job cannot push). Failing tests go back to the builder like review comments and count in the PR's metrics.
- **Review.** In the default pipeline it runs once the head's tests passed: an independent reviewer (`claude -p`, read-only: no shell, no gh) gets the request text, the diff and the PR's comments, and returns a strict JSON verdict (`approve`/`changes`, every field required; anything else is a failed job, retried and then escalated). The loop posts its `[blocking]` / `[non-blocking]` comments. Blocking items (and request items not handled) are written to `.loop/<file>` in the builder's working folder and the builder gets one fixed sentence naming it (`runner.deliverFile`); after its next push the round goes up and the PR is tested and reviewed again. A blocking verdict in round 5 sends the PR to the human: "PR #x hit 5 rounds: options Continue 5 more / Take over / Close".
- **QA.** The tester decides whether the change needs manual QA (with no tester before it in the pipeline, QA runs when the diff touches UI files); in the default pipeline it runs after the reviewer approved, and a QA job drives the app with the headless Playwright MCP. Failures go back to the builder like review comments and count in the PR's metrics.
- **Merge.** Only a head that passed every check of the pipeline is merged; any other head goes back to the first check. Auto-merge on: squash-merge at that head. Off: the human gets Merge / Hold / Close for that head (the short SHA is in the question); that question has a 10-year deadline (no 15-minute default) and recommends Hold. Answers match exactly (option text or number). Hold asks again a day later. Auto-merge is re-checked at the moment of merging.
- **Deploy.** With `vercelProject` set on the repo, the loop watches the merge commit's deployment in the project's production environment ("Production" or "Production – <project>", exactly), from GitHub deployment statuses (Vercel's GitHub app writes them). On failure it opens and merges a revert PR at once (`gh pr revert`; it only ever merges the PR number it got back), marks the PR `reverted`, and records a `[loop] Fix deploy failure of PR #x: …` request through the server's RequestService; the router starts its session, and that session's PR gets `fixesPrId`. A revert that keeps failing goes to the human.
- **Production Guardian.** After the deploy, the lane's last node. It runs only for repos with a `productionUrl` (an https URL; set it on the repo like `vercelProject`) and has two triggers: a PR the loop finished with (stage `deployed`) gets its deploy verified, and every guarded repo gets a regression run once every 24 hours, with or without new deploys (`packages/loop/src/guardian.ts`, `guardian_runs` table, `GET /api/guardian/runs`). A run is four agent jobs in a checkout of the deployed code (read-only, headless Playwright): **API** (endpoints), **UI** (critical flows), **performance** (response times, errors) and **integrations** (external dependencies). They reuse the tests the builders wrote and tagged `@prod-safe` (the builder and tester prompts say so), run nothing else against production, and sign in only with dedicated test accounts whose credentials come from the project's env files (`GUARDIAN_*` / `TEST_*`). This is enforced by the prompt only, and jobs get the project's whole env files, so put only test credentials in a guarded repo's env files. On a failure: each failing area is retried once (a pass on retry is recorded as flaky, not a failure); what still fails is kept as evidence (job logs, a `report.md`, screenshots) under `LOOP_JOBS_ROOT/guardian/run<id>/`; an agent diagnoses it; and a `[loop] Production Guardian: …` request goes to the router for a builder session (one per ongoing failure: the next failing run points at the open one until a run passes). A _critical_ failure (site down, sign-in or a main flow broken) also raises an "Acknowledge" question that the dashboard shows for a week. A check that could not run (agent crash, usage limit) is an `error` run, not a failure: it is retried after 30 minutes, three times at most (daily runs then wait a day before trying again). `LOOP_GUARDIAN_PROVIDER` picks the CLI (default claude). The dashboard's Guardian node shows the latest result per PR.
- **Cleanup.** After merge: delete the remote branch only while it still points at the merged head, end the session (the runner removes its worktrees) once its last PR is done, and delete each merged repo's local branch only if all its commits were merged. A session with uncommitted changes is stopped instead and keeps its worktree. A closed PR keeps its branches and its session is paused.
- **Jobs.** Each job runs in a detached worktree at the exact head (`LOOP_JOBS_ROOT`) from which the PR's own agent config (`opencode.json*`, `.opencode/`, `.claude/`, `.mcp.json`) is removed, on the builder's provider (OpenCode with the same rights when the session fell back), with user settings only (`--setting-sources user`, no hooks) and a scrubbed environment: no server tokens, an empty gh config and no git credentials. A job's whole process group is killed when it ends or times out. The loop's own git commands run with hooks and fsmonitor off and a scrubbed environment.
- **Known limitation: jobs run as your OS user with your real HOME** (Claude's login needs it). A tester or QA shell, or the PR code it runs as tests, can still reach credentials kept under HOME (`~/.ssh`, `~/.config/gh`, a `vercel` login), the server's `.env` and the SQLite file, and can write repo config the loop's git reads (for example filter drivers). **Before running the loop on any repo that accepts outside input**, give jobs a dedicated HOME holding only what Claude needs (with `CLAUDE_CODE_OAUTH_TOKEN`), or enable Claude Code's sandbox through `--settings` (filesystem denies for those paths plus a network allowlist).
- **Robustness.** Every transition is saved to the PR row (`stage`, `round`, `outcome`, `loopState`), so a restart carries on where it stopped. One step per PR at a time, at most `LOOP_MAX_JOBS` agent jobs at once, and comments and requests are never created twice.

### Rigor per session

Each session has a rigor level (`sessions.rigor`, migration 21), set from the dial above its pipeline on the board, with `PATCH /api/sessions/:id { "rigor": "…" }`, or by the Planner. One axis trades safety against time and money together. **Every level runs every stage of the pipeline**; a level changes the effort of the agents and how strict their checks are, never which stages run (to leave a check out for one PR, use its **Skip**). The policy is in `packages/loop/src/rigor.ts` (effort in core's `RIGOR_EFFORT`); the engine reads the level on every step and every job, so a change applies from the next job on and restarts no finished stage.

| Level                 | Agents' effort (`claude --effort`)               | Tests                                                 | Code review                                                                       | QA and custom checks                |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------- |
| `fast` (Fast)         | `low`                                            | only the existing tests related to the change; no new | only correctness bugs and security problems block; 1 round before the PR is yours | as the stage's `runs` rule says     |
| `light` (Light)       | `medium`                                         | the same                                              | the same; 2 rounds                                                                | as the stage's `runs` rule says     |
| `standard` (default)  | the session's own, else the CLI's default (high) | as the stage is                                       | as it is                                                                          | as it is                            |
| `thorough` (Thorough) | `max`                                            | the tester writes tests for every behaviour changed   | also weighs edge cases, error handling and missing tests, and makes gaps blocking | QA on every PR (if in the pipeline) |

- **Effort.** Each PR-loop job (tests, review, QA, custom checks, conflict fixer) is launched with `--effort` for the PR's session's level, read when the job starts. The builder session gets it when it launches or resumes (`effortFor(session.rigor, session.effort)`): the flag is fixed for a running process, so a dial change reaches the builder at its next resume. Standard adds no flag to a job and keeps the session's own effort for the builder. OpenCode has no effort flag, so the level only affects its prompts and round cap there.
- **Notes.** Fast and Light add a line to the tester's and reviewer's instructions (`testerNote`, `reviewerNote`), Thorough its own; none lets request text override a rule. The tests the tester writes anyway at Fast and Light are not pushed.
- **Rounds.** Fast gets 1 review round before the PR goes to you, Light 2; "Continue" still adds rounds.
- **Merge.** The usual rule applies at every level: with auto-merge on, a PR whose code review passed merges without asking; with it off, or no review, you approve. The merge question names the level when it is not Standard.
- **Who sets it.** `sessions.rigor_source` (migration 23) is `default` (a new session, Standard), `planner` or `human`, with the Planner's one-sentence `rigor_reason`. The Planner's `submit_plan` sets the level only while the source is not `human`; the dial (`PATCH /api/sessions/:id`) sets it and marks the source `human`, and from then on the Planner never changes it, on later tasks of the session too. Each change by you is a `decision` history entry. The tree carries `rigor`, `rigorSource` and `rigorReason`.
- **Planner's rubric** (in `planner.md`): fast for a typo, copy or text change, a config value, a comment, a docs change or a tiny isolated edit; light for a small, well-understood change in one area with low blast radius; standard for ordinary feature or fix work; thorough for anything touching auth, payments, billing, data migrations or deletion, security, public APIs, an area with weak tests, or a large cross-cutting change; the stricter level when unsure.

Folder projects have no PRs and no dial.

## Searchable history

- **Transcripts.** Every minute the server looks at paused and ended sessions. If a session's Claude conversation (`$CLAUDE_CONFIG_DIR/projects/<cwd with non-alphanumerics as "-">/<agentSessionId>.jsonl`, found in any folder if Claude shortened the name) changed since it was last stored, a compact text goes into the project history as one `transcript` entry per session, replacing the older one. The text has user and assistant text only (no tool calls, tool output, thinking or injected reminders), capped at 60 000 characters, keeping the start and the end. Token shapes, the project's env values and the server's own secrets are replaced with `***` before storing. An ended session whose transcript was stored after it ended is not looked at again. OpenCode sessions have no Claude transcript.
- **Decisions** written by other modules (provider switches, review outcomes, routing) are `decision` entries, as before.
- **Redaction on read.** Search results (the MCP tool and the API) are redacted again when read, whatever module wrote the entry, and the snippet is cut from the redacted text.
- **`search_history` MCP tool** on the same `/mcp` server as `ask_human`: `search_history({ query, limit?, kind? })` returns the top `limit` (default 5, max 20) snippets from the caller's project only. The project comes from the connection's `X-Loop-Session-Id` header; there is no argument to pick another project.
- **`GET /api/history?q=&projectId=&kind=&limit=`** (dashboard token) for the dashboard; without `projectId` it searches every project.

### Importing past Claude Code sessions

Past Claude Code conversations of a registered project can be brought into the dashboard as **finished** sessions, each with its searchable transcript:

```sh
npm run import-sessions -w @loop-engineering/server -- --project resume --dry-run   # count first
npm run import-sessions -w @loop-engineering/server -- --project resume
npm run import-sessions -w @loop-engineering/server -- --project shop-web \
  --also-dir /Users/me/shop-web-worktrees/fix-cart   # a worktree's conversations too
npm run import-sessions -w @loop-engineering/server -- --project shop-web \
  --also-dir=-Users-me-shop-web-worktrees-fix-cart   # the same, by folder name (note the "=")
```

- **Where it looks.** `<claude dir>/projects/<folder>/<sessionId>.jsonl`, where the folder is the path Claude ran in (symlinks resolved with `realpath`) with every character other than a letter or digit as `-` (`/Users/me/shop.web` → `-Users-me-shop-web`): the folder of a folder project, or each repo path of a git project. `--also-dir` adds a folder by name or by the absolute path Claude ran in (a worktree). Folders whose names start with one of those names (e.g. `-Users-me-shop-web-worktrees-x`) but were not read are listed in the summary. `--claude-dir` (default `$CLAUDE_CONFIG_DIR` or `~/.claude`) and `--db` (default `LOOP_DB_PATH`) pick other locations.
- **What it stores.** One ended session per conversation: provider `claude`, `agentSessionId` = the file's id, `source: "import"`, the title from the first real user message (one line, at most 80 characters, secrets masked), `createdAt`/`endedAt` from the first and last message, the last model used, no branch, worktrees or tmux target. Its compact transcript (user and assistant text only, capped at 60 000 characters) goes into the project's history like any other, with token shapes, the project's env values (its env files and the `.env*` files at the top of its folders) and the server's secrets masked. The transcript sweep leaves imported sessions alone.
- **Idempotent.** A conversation the project already has (imported before, or started by the runner) is skipped, so running it again only adds new conversations. Empty files, files with no valid line, symlinks, unreadable files and conversations changed in the last 5 minutes (still running; `--include-active` imports them anyway) are skipped and counted. A damaged line inside an otherwise valid file is left out and counted.
- **Read-only and quiet.** Claude's folder is never written: files are opened read-only without following symlinks and streamed line by line (a 100 MB file of ordinary lines is never held in memory). Each line is still read whole, so very long lines (a big file pasted into a tool result) cost memory of a few times the longest line while that file is read (measured peak: 155–195 MB for files of 53 × 1 MB, 3 × 4 MB, 1 × 9 MB and 1 × 20 MB lines). A message over 1 MB keeps only its first and last 256 KB (cut at whitespace, each piece redacted, the cut edges masked). A file that still cannot be read is skipped and counted as unreadable. Only counts, folder names and redacted titles are printed (`--quiet` leaves the titles out); no transcript text. Any failure is one line (error class, redacted message), never a stack trace. No network.
- **Redaction.** Each message is redacted whole before anything cuts it (title, 60 000-character cap), and whatever sits at a cut or a message edge that could be half a token is masked too. `redactSecrets` (core, also used by the transcript sweep, `search_history` and `GET /api/history`) masks the token shapes of GitHub, Anthropic/OpenAI, Slack (tokens and webhooks), Discord webhooks, AWS, Stripe, Google, GitLab, npm, Hugging Face, Vercel, Notion, Tavily, Linear, PostHog, Sentry, SendGrid, Telegram bot tokens and JWTs; whole private key blocks (PEM, OpenSSH, PGP, also JSON-escaped or cut off before END); `password=…`, `api_key: …`, `"token": "…"`, `?secret=…` style settings, `Authorization`/`Bearer` values and URL credentials; long random-looking strings; all of these also when a line break was put inside them. It prefers over-masking: a word right after a token on the next line can be masked with it, and so can long random-looking data (base64 images, some long identifiers). Code identifiers made of words (`handleCheckoutFormSubmit2`), hex hashes, UUIDs, paths, SRI hashes (`sha256-…`) and GitHub `#diff-` anchors are kept. Not detected: a multi-word passphrase written in prose ("the passphrase is correct horse battery staple"), or a secret of no known shape that is short and not written as `name=value`. Every rule is linear in the text length (the server redacts on its event loop); `secrets.perf.test.ts` checks each against 1–2 MB of adversarial text.
- **Shared Claude folders.** Claude's folder names are lossy (`~/my.app` and `~/my-app` both become `-Users-me-my-app`). When two registered projects map to the same folder name, the importer refuses that folder for both rather than mix their transcripts.
- **Dashboard.** Imported sessions appear under their project in a collapsed **Finished (N)** group, newest first, each marked **Imported** with its date; the first 20 show, the rest behind "Show N more". Ended and imported sessions have no End session button, and `POST /api/sessions/:id/end` refuses imported ones (409).
- Needs migration 9 (`sessions.source`), applied when the importer or the server opens the database: restart the server on the new build when you run the importer.

New server modules can add MCP tools the same way: a `ServerModule` with `mcp(server, connection, ctx)` registers tools on each `/mcp` connection.

## License

[MIT](../LICENSE)
