# Loop Engineering — agent instructions

Read SPEC.md for what we're building and PLAN.md for the build order and milestone status.

## Repo layout (npm workspaces, TypeScript, ESM, Node 20)
- `packages/core` — data model, SQLite store, shared types, config
- `packages/runner` — session runner (tmux + Claude CLI / OpenCode fallback, worktrees)
- `packages/ask-human` — `ask_human` MCP server + question bus
- `packages/router` — routes each request to a session of the project it names
- `packages/loop` — PR loop engine (review → tests → QA → merge → deploy → cleanup)
- `apps/server` — always-on Node server wiring the packages together (HTTP API)
- `apps/dashboard` — Next.js dashboard (Vercel)

## Rules
- Use npm. One root `npm install`; never install per package. Do not add heavy dependencies without need, and never copy `node_modules`.
- Before writing a new module, check npm/GitHub for an existing well-maintained library and note in the PR why you reused or built.
- Every external effect sits behind an interface with a fake for tests: tmux, `claude`/`opencode` CLIs, `gh`, git remotes, Vercel, clock. Tests never hit the network, never send real messages, never deploy.
- Tests: vitest. `npm test` at the root must pass, plus `npm run typecheck` and `npm run lint`.
- Keep code small and readable; comment only non-obvious decisions.
- Secrets never go in the repo. `.env*` is gitignored; document needed vars in `.env.example`.

## Process (every milestone)
1. Builder works on a branch `m<N>-<slug>` in its own worktree under `../loop-engineering-worktrees/`, opens a PR with `gh pr create`.
2. A different agent reviews the diff and posts review comments on the PR. The builder fixes them. Max 5 rounds.
3. A different agent runs the tests and exercises the feature, and posts results on the PR.
4. Merge only when review has no blocking comments and tests pass. Squash-merge, delete the branch, remove the worktree.
5. Vercel: preview deploys only. Never deploy to production.
