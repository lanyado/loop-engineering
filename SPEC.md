# Loop Engineering — spec

The original spec, as of 2026-10-18. Decisions made after that are recorded in "Decisions after the snapshot" below, and they win over the original text.

A custom-built orchestrator that runs coding agents in a loop. Version 1 includes everything below. Items marked **(AI)** are judged or created by the AI; everything else is human input.

Hierarchy: Projects → Sessions → Subagents.

## Global
- **Usage limits:** when Claude runs out, switch to a free model (OpenCode free models, e.g. `opencode/glm-5.3-flash-free`) **(AI)**, with the same rights, including merge.
- **Runtime:** local Mac only for now. No GPU support.
- **Hosting:** local only: the server and dashboard listen on 127.0.0.1 and nothing is exposed to the network. Telegram runs in long-polling mode (outbound only).
- **Stack:** TypeScript everywhere. Next.js dashboard and Node server run locally; Node server for the Telegram bot and orchestrator. Sessions run as Claude Code CLI processes in tmux, driven by the orchestrator.

## Project (a group of one or more repos, e.g. frontend + backend)
- Session list (active/ended)
- Searchable history of past sessions (transcripts + decisions) that new sessions can search
- ENV VARS: local .env files on the Mac, copied into each session's worktree
- Auto-merge on/off
- Marked for direct input on/off (set manually in the dashboard)

## Session (main context window)
- Main ownership; runs on the strongest model
- Its own git worktree + branch (per repo)
- Infrastructure requests (MEMORY…) **(AI)**
- Subagent titles + params (model/effort) **(AI)**
- Subagent ↔ human communication via an `ask_human` MCP tool on the always-on server **(AI)**, reachable from local sessions. The subagent sends a question + answer options **(AI)**; the human answer is returned. No answer within 15 minutes → the subagent goes with its recommended option and notes it **(AI)**.
- MCP tools/skills a subagent is started with: tavily, playwright, context7, GitHub MCP, opensource-search skill. Opensource search is mandatory: before writing any new module, search GitHub/npm/PyPI and justify building vs reusing.

## Flow
1. **Input.** Questions from subagents are shown in both channels; the first answer wins and the other channel gets an "answered: X" confirmation. Proactive notifications only when a question is waiting.
   1. Telegram bot: answer questions and send new tasks (routed per step 2). Only the owner + an allowlist managed outside the dashboard (core `Settings.telegramAllowlist`).
   2. Web dashboard (usable from phone): pending questions inbox; projects → sessions → subagents tree; PR pipeline (tests, review, QA, merge); loop metrics per PR (cost, tokens, rounds, failures, outcome); settings toggles (auto-merge, marked for direct input, …).
2. **Direct input (AI)** to the right project among marked projects, and to an open session or a new one. If unclear, ask the human with the likely projects/sessions as options.
3. **Tests:** run relevant existing unit & integration tests, add more if needed. The builder writes tests for its changes as part of building. If tests fail, back to the building agent.
4. **Code review agent** writes comments on the PR; runs only after tests pass. The reviewer also has the user's request and checks everything in it was handled. Stops when the reviewer has no comments left, or after 5 rounds, when the PR is sent to the human with the open comments/failures.
5. **Manual QA** with Playwright MCP, when the AI judges the PR needs it **(AI)**. Runs after review approves.
6. **Merge** to main (automatically, or after human approval, per the project's auto-merge setting) and deploy to Vercel. If the deploy fails, revert the merge right away, then fix it in a new PR through the loop.
7. **Production Guardian** (simple, two triggers): after every deploy it verifies the deployed change and the critical workflows on the live site, and once every 24 hours it runs a regression check, with or without a deploy. Four checks: API, UI (Playwright), performance, integrations. Only production-safe tests (reusing the ones written during Build) with dedicated test accounts. On failure: retry once, collect logs/screenshots, AI diagnosis, a task for the Build agent, and a dashboard alert when critical.
8. **Cleanup:** after merge, delete local & remote branches.

## Decisions after the snapshot
- 2026-10-18: removed the calendar connection, the pause during video calls, and the travel handoff to Claude Code cloud. The code is not part of this repository.
- 2026-10-18: dashboard and server are local-only (127.0.0.1) for now; the Vercel preview was deleted. Moving sessions to Claude Code cloud and an always-on server are deferred.
- Kept: searchable history, per-session MCP tokens, free-model fallback.
- 2026-10-25: an email channel (Gmail): an allowlisted sender mails a task, the loop replies with clarifying questions if needed, then the plan as approved, carries the agents' questions on the same thread, and writes there when the new version is in production.
- 2026-10-25: each session has a rigor dial (Fast, Light, Standard, Thorough) above its pipeline that trades safety against time and money for its PRs: Fast runs no checks and merges on CI when auto-merge is on, Light only tests and review (2 rounds), Standard the pipeline as it is, Thorough every check with QA on every PR. Details in docs/reference.md.
