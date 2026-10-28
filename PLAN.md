# Build plan (v1)

Status here is updated as each milestone merges.

| # | Milestone | Depends on | Status |
|---|-----------|------------|--------|
| M1 | Monorepo skeleton, data model, SQLite store, CI | — | done |
| M2 | Session runner: Claude CLI in tmux, worktree per session per repo, OpenCode free-model fallback | M1 | done |
| M3 | `ask_human` MCP server + question bus (15-min default, first answer wins) | M1 | done |
| M4 | A second question channel, allowlist, new tasks, cross-channel confirmations (now a private local add-in) | M1 | done |
| M7 | Next.js dashboard: inbox, tree, PR pipeline, metrics, settings toggles | M1 | done |
| M5 | Router: direct input to marked project/session, ask with options when unclear | M2–M4, M7 | done |
| M6 | PR loop engine: review loop (cap 5), tests, AI-decided QA, merge per auto-merge, deploy watch + revert, branch cleanup, metrics | M2–M4, M7 | done |
| M8 | Searchable history + per-session MCP tokens | M5, M6 | done (history + tokens only) |
| M9 | End-to-end run on a sandbox repo + morning report | M5, M6 | todo |

Why this order: M1 fixes the data model every other piece shares. M2–M4 and M7 only touch their own package, so they can be built in parallel. The router and the loop engine need sessions, questions and channels to exist. Calendar/travel/history are add-ons on top of a working loop.

## Follow-ups (non-blocking review notes, not yet done)

- Runner: escalate actions blocked by the permission mode to ask_human.
- Runner: switch a session back from OpenCode to Claude when the usage limit resets.
- Runner: verify on the first real fallback that `OPENCODE_CONFIG_CONTENT` wins over a repo's `opencode.json`, including keys the runner doesn't set (e.g. `github_*`).
- Runner: OpenCode tool timeout for a 15-minute blocking ask_human is unconfirmed.
- Runner: export `CLAUDE_CONFIG_DIR` to the agent so resume finds saved conversations; clearer error when a non-forced `end()` keeps worktrees.
- Runner: Claude folder trust must be granted once by hand per repo main checkout (worktrees inherit it), plus `WORKTREES_ROOT` for multi-repo sessions; the monitor turns a session stuck at the trust prompt into a question. Verify `--permission-mode auto` with the session model on the first real run.
- ask_human: "delivered" means a waiter was woken, not that the agent received the response.
- Server: `close()` during a still-running `start()` lets the sweeper start on a closed store (harmless for `main.ts`, which exits).
- Dashboard: login lockout counts failures after PBKDF2, so parallel guesses slip through; the global 10-failure lockout lets anyone who can reach `/login` lock the owner out (Vercel deployment protection covers this today); client IP comes from `x-forwarded-for` (only trustworthy behind Vercel); `viewer-gate.test.ts` lists pages by hand; e2e runs at 1 worker; projects can't be created from the UI.
- Loop: git config a job plants in the shared repo (ssh command, credential helper, filter drivers, signing program) can run in the loop's own git commands; add overrides and refuse to commit/push if repo config changed during a job. "Continue 5 more" runs 6 reviews. `QuestionService.cancel(id)` for stale approval questions. Test that questions from ended sessions reach the inbox. A newer fork PR on the same branch name hides the genuine PR. `SessionRunner.end()` runs unhardened git.
- Jobs run with the real HOME (credentials under it are reachable): use a dedicated job HOME or Claude Code's sandbox before running the loop on any repo that accepts outside input.
- Calendar pausing and travel handoff removed by decision; can be re-added if needed (the code is not in this repository).
- Dashboard (review notes): the launcher's flag check misses the attached forms `-H0.0.0.0` / `-p4000` (the app's own startup check still refuses them); the real-socket detection uses the private `process._getActiveHandles()`, so add a test that fails if that API changes; limit the 44px vertical padding to standalone links so focus rings on consecutive inline links don't overlap. No per-request peer check exists (Next 16 exposes no peer address), so the loopback guarantee is startup-only.
- Server: a module whose `start()` fails is reported as "Cannot listen on host:port"; document that `localhost` binds IPv6 `::1` only on macOS (observed).
- Folder projects: the one-session-per-folder rule is enforced in the runner process only (no DB constraint); a partial unique index on an `open_folder_project_id` column would be needed if a second process ever starts sessions. The busy-folder escalation question is asked at most once per request per server process.
- Session import: an already-imported conversation that Claude later continued (`claude --resume` outside the loop) is not refreshed on a re-run; the transcript stays as first imported. Claude shortens very long cwd folder names with a hash; such folders are only found through `--also-dir <folder name>`.
