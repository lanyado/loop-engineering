# Stages

Each `.md` file here is one check of the PR loop: a prompt plus a few settings. These are the
built-in ones. To change one or add your own, put a file in `data/stages/` (gitignored): one with a
built-in's name replaces it, any other is a new check. The dashboard's pencil writes the same files.

```md
---
title: Security review
label: Security
icon: shield
access: read
runs: always
---

Look for secrets committed in the diff and for unsafe handling of user input.
```

| Setting  | Values                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------- |
| `title`  | Its full name, used in PR comments                                                             |
| `label`  | The pipeline node's name, 10 characters at most; needed when the title is longer               |
| `icon`   | `tests`, `review`, `qa`, `shield`, `lock`, `bug`, `book`, `gauge`, `globe`, `sparkle`, `check` |
| `access` | `read` (files only), `shell` (can run commands) or `browser` (a shell and a headless browser)  |
| `runs`   | `always`, or only when the diff changes that kind of file (below)                              |

`runs` values besides `always`: `code-changes` (anything but Markdown, MDX, reStructuredText or
AsciiDoc docs), `ui-changes` (pages, components, styles), `server-changes` (source that isn't UI,
tests or tool config such as `vite.config.ts`), `test-changes`, `docs-changes`, `dependency-changes`
(package manifests and lockfiles), `database-changes` (migrations, `.sql`, schemas) and
`infra-changes` (CI, Docker, deploy config, Terraform).

The prompt (4,000 characters at most) says what to check. The loop adds the PR, the request and
the diff, and asks for pass or fail; failures go back to the builder like failing tests. No stage
can edit files or push. The file name is the id: lowercase letters, digits and dashes. For the
built-in `tests`, `review` and `qa`, `access` and `runs` are fixed.

A file that doesn't parse is never skipped: PRs wait at that check (the server logs why) until it's
fixed. While `pipeline.json` can't be read, the loop does nothing at all.

`guardian.md` holds the Production Guardian's own instructions, added to every Guardian run (it
checks the live site's API, pages, speed and integrations after each deploy and once a day). Only its
prompt is used, though the file still needs its `---` block; it is never a check. A
`data/stages/guardian.md` replaces it, and a broken one leaves the built-in instructions in use.

`planner.md` holds the Planner's instructions: every session agent plans each new task before it
builds, following them (it reads the code, asks you with `ask_human` when something is unclear, and
records a short plan with the `submit_plan` tool). Like `guardian.md`, only its prompt is used, it is
never a check, a `data/stages/planner.md` replaces it, and a broken one leaves the built-in
instructions in use. A change reaches sessions started or resumed after it.

`planner` is a reserved stage id now: a custom stage already named `planner` must be renamed.

`pipeline.json` sets the order of the checks, and whether the loop watches deploys and runs the
Production Guardian after a merge:

```json
{ "checks": ["tests", "review", "qa"], "deploy": true, "guardian": true }
```

Merging always waits for CI, and without `review` in `checks` every PR waits for your approval.
