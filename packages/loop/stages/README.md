# Stages

Each file here is one stage of the PR loop: a prompt plus a few settings. These are the built-in
stages. Don't edit them in place; put your own versions in `data/stages/` (next to the database,
gitignored). A file there with the same name replaces the built-in one, and any other `.md` file is a
new stage. The dashboard's pencil writes the same files.

```md
---
title: Security review # its full name, used in PR comments
label: Security # the pipeline node's name, 10 characters at most
icon: shield # tests, review, qa, shield, lock, bug, book, gauge, globe, sparkle or check
access: read # read (files only), shell (can run commands) or browser (shell plus a headless browser)
runs: always # always, or ui-changes (only when the diff touches UI files)
---

What to check, in plain words. The loop adds the PR, the request and the diff, and asks for a
pass/fail decision. Failures go back to the builder, like failing tests do.
```

A file name is the stage's id: lowercase letters, digits and dashes, at most 32 characters.
`access` and `runs` are fixed for the built-in stages (tests, review, qa): their versions in
`data/stages/` can change the title, label, icon and prompt only. No stage can edit files or push.

`pipeline.json` is the order the loop runs the checks in, and whether it watches deploys and runs the
Production Guardian after a merge:

```json
{ "checks": ["tests", "review", "qa"], "deploy": true, "guardian": true }
```

Merging always waits for CI. Without `review` in `checks`, every PR also waits for your approval,
even in projects with auto-merge on.
