# Loop Engineering — spec

The original spec, as of 2026-10-18. Decisions made after that are recorded in "Decisions after the snapshot" below, and they win over the original text.

A custom-built orchestrator that runs coding agents in a loop. Version 1 includes everything below. Items marked **(AI)** are judged or created by the AI; everything else is human input.

Hierarchy: Projects → Sessions → Subagents.

## Global
- **Usage limits:** when Claude runs out, switch to a free model (OpenCode free models, e.g. `opencode/glm-5.3-flash-free`) **(AI)**, with the same rights, including merge.
- **Runtime:** local Mac only for now. No GPU support.
- **Hosting:** local only: the server and dashboard listen on 127.0.0.1 and nothing is exposed to the network.
- **Stack:** TypeScript everywhere. Next.js dashboard and Node server run locally; the Node server runs the orchestrator. Sessions run as Claude Code CLI processes in tmux, driven by the orchestrator.

## Project (a group of one or more repos, e.g. frontend + backend)
- Session list (active/ended)
- Searchable history of past sessions (transcripts + decisions) that new sessions can search
- ENV VARS: local .env files on the Mac, copied into each session's worktree
- Auto-merge on/off

## Session (main context window)
- Main ownership; runs on the strongest model
- Its own git worktree + branch (per repo)
- Infrastructure requests (MEMORY…) **(AI)**
- Subagent titles + params (model/effort) **(AI)**
- Subagent ↔ human communication via an `ask_human` MCP tool on the always-on server **(AI)**, reachable from local sessions. The subagent sends a question + answer options **(AI)**; the human answer is returned. No answer within 15 minutes → the subagent goes with its recommended option and notes it **(AI)**.
- MCP tools/skills a subagent is started with: tavily, playwright, context7, GitHub MCP, opensource-search skill. Opensource search is mandatory: before writing any new module, search GitHub/npm/PyPI and justify building vs reusing.

## Flow
1. **Input.** Questions from subagents are shown in every channel that is set up; the first answer wins and the others get an "answered: X" confirmation. Proactive notifications only when a question is waiting.
   1. Other channels (private local add-ins): answer questions and send new tasks (routed per step 2).
   2. Web dashboard (usable from phone): pending questions inbox; projects → sessions → subagents tree; PR pipeline (tests, review, QA, merge); loop metrics per PR (cost, tokens, rounds, failures, outcome); settings toggles (auto-merge, …).
2. **Input to a project**: a task names its project (the session's own + button, or an add-in) and gets a new session there, or goes into its open session. The Planner asks the human only when the task is genuinely ambiguous.
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
- 2026-10-25: each session has a rigor dial (Fast, Light, Standard, Thorough) above its pipeline that trades safety against time and money for its PRs: Fast runs no checks and merges on CI when auto-merge is on, Light only tests and review (2 rounds), Standard the pipeline as it is, Thorough every check with QA on every PR (superseded on 2026-10-28, below). Details in docs/reference.md.
- 2026-10-28: the rigor dial no longer drops checks: every level runs every stage. A level sets the agents' effort (Fast low, Light medium, Standard as before, Thorough max) and how strict the checks are (Fast and Light run only related tests, block only on correctness and security, and get 1 and 2 review rounds; Thorough writes tests for every change and runs QA on every PR). This replaces the 2026-10-25 wording where Fast ran no checks and Light only tests and review; skipping a stage is the per-PR Skip. The Planner now judges the level in `submit_plan` and says why; the human can change it any time, which applies from the next job on and pins it against the Planner. Details in docs/reference.md.
- 2026-10-28: the Planner also chooses the model of each agent for the task, next to the rigor level: the builder, and each check of the PR loop (`tests`, `review`, `qa`, custom stages, the conflict fixer), through an optional `models` object in `submit_plan` with a one-line reason. The human sees the model name on top of each agent's node on the dashboard and can change it there, which pins it against the Planner. A pick applies from the agent's next job (the builder: its next resume, or at once when the plan itself changes it, by relaunching the live builder, which a change of effort from the Planner's level pick can also do); sessions with no pick behave as before, and the OpenCode fallback keeps its own models. Names are free text within a conservative character set, so new models work without a code change. Details in docs/reference.md.
- 2026-10-26: channels other than the dashboard are private local add-ins (`local/`, gitignored), not part of this repository.
- 2026-10-26: the pipeline's first node is the Planner, not "Session": the session agent plans each new task before it builds (reads the code, asks the human with `ask_human` if unclear, records a short plan with `submit_plan`), following `planner.md`, which the owner edits like the Guardian's instructions. It is a phase of the same agent, not a separate one. The terminal moved to the Builder node. Details in docs/reference.md.
- 2026-10-30: each project can have its own pipeline: a `.loop-engineering/` folder in its folder (or its first repo), holding the same stage files as the shared `data/stages/` (which projects without one keep running). `loop init` in a project's folder makes it, a copy of the shared pipeline, adding the folder as a project first if needed; the PR loop, the Guardian and the Planner read each project's own. The pencil edits only pipelines now, with a tab for the shared one and one per project (a project's first Save there makes its copy); the top bar items and row details are no longer editable, and everything shows. Details in docs/reference.md.
