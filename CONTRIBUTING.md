# Contributing

Thanks for helping. Loop Engineering is small and mostly built by the agents it runs, so the rules below are the same ones its own builders follow ([CLAUDE.md](CLAUDE.md)).

## Before you start

- **Bugs and ideas** go in [an issue](https://github.com/lanyado/loop-engineering/issues/new/choose) first, so we can agree on the approach before you write code. Small fixes (a typo, an obvious bug with a test) can go straight to a PR.
- **Security problems** never go in a public issue: see [SECURITY.md](SECURITY.md).
- Read [SPEC.md](SPEC.md) for what Loop is for, and the [reference](docs/reference.md) for the part you touch.

## Setup

Node 20.19 or later (`.nvmrc`), git and tmux. macOS and Linux both work for development.

```sh
git clone https://github.com/lanyado/loop-engineering.git
cd loop-engineering
npm install          # one install at the root; never per package
npm test             # no build needed: tests resolve the packages' sources
```

You don't need Claude Code, `gh` or a running server to work on most of the code: every external effect has a fake. `npm run setup` and `npm start` run the real thing ([README](README.md#quick-start)), and `SERVER_URL= npm run dev -w @loop-engineering/dashboard` runs the dashboard on demo data.

## The gate

Every PR must pass these: CI's checks (`.github/workflows/ci.yml`, which also builds) plus `npx tsc -b`:

```sh
npx tsc -b              # the build's project references
npm run typecheck       # every package, tests included
npm run lint            # eslint (type-aware) and prettier --check, Markdown included
npm test                # vitest
```

`npm run format` fixes formatting. On a machine shared with other work, keep the test run small: `npm test -- --maxWorkers=3`. Changes to auth (the `/mcp` or `/api` tokens, session tokens, the dashboard login) also need `npm run test:e2e`, which CI doesn't run.

## Tests

- **No network, ever.** Every external effect sits behind an interface with a fake: tmux, the `claude` and `opencode` CLIs, `gh`, git remotes, mail, Vercel and the clock. Tests never reach GitHub, a model, a mailbox or a deploy, and never send a real message.
- **Silent and self-contained.** Tests print nothing they don't need, play no sound, and leave nothing behind. A test that needs real tmux uses its own socket (`loop-test-<pid>`), never your default tmux server. A test that needs real git uses temporary repos. SQLite runs in memory or in a temp file.
- **Deterministic.** Use `FakeClock` for time, not real waits. A test must pass on any machine, in any time zone and in any order.
- **A test for the change.** A fix comes with a test that fails without it; a feature with tests of what it does, including the failure paths.

## One change per PR

- Keep each PR to one change you can describe in one sentence. Refactors, formatting and dependency bumps go in their own PRs.
- Branch from `main`. The PR description says what changed, why, how you tested it, and what you could not test.
- Before writing a new module, look for a maintained library that already does it, and say in the PR why you reused or built.
- No heavy dependencies without need.
- Secrets never go in the repo. A new setting goes in `.env.example`, `docs/examples/server.env` and the reference.
- User-facing changes get a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Anything an operator must do on upgrade (a migration, a renamed setting) goes under **Upgrade notes**.

## How PRs are reviewed

Loop reviews its own PRs the way it reviews the projects it runs, and a person decides the merge:

1. The builder (a person or an agent) works on a branch in its own worktree and opens the PR.
2. A different agent reviews the diff and posts `[blocking]` and `[non-blocking]` comments. The builder fixes the blocking ones, for at most 5 rounds.
3. Another agent runs the gate and exercises the feature, and posts what it ran and what it saw.
4. A maintainer squash-merges it once the review has nothing blocking and the tests and CI pass, and the branch is deleted.

Your PR may get comments from these agents as well as from people. Answer them like any review: fix what is right, and explain what you think is wrong.

## Releases

Maintainers cut releases as described in [RELEASING.md](RELEASING.md).

## License

By contributing, you agree that your work is released under the [MIT License](LICENSE).
