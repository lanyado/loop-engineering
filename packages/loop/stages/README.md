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
| `runs`   | `always`, or `ui-changes` (only when the diff touches UI files)                                |

The prompt (4,000 characters at most) says what to check. The loop adds the PR, the request and
the diff, and asks for pass or fail; failures go back to the builder like failing tests. No stage
can edit files or push. The file name is the id: lowercase letters, digits and dashes. For the
built-in `tests`, `review` and `qa`, `access` and `runs` are fixed.

A file that doesn't parse is never skipped: PRs wait at that check (the server logs why) until it's
fixed. While `pipeline.json` can't be read, the loop does nothing at all.

`pipeline.json` sets the order of the checks, and whether the loop watches deploys and runs the
Production Guardian after a merge:

```json
{ "checks": ["tests", "review", "qa"], "deploy": true, "guardian": true }
```

Merging always waits for CI, and without `review` in `checks` every PR waits for your approval.
