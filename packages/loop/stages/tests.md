---
title: Tests
label: Tests
icon: tests
---

Steps:
Be quick: aim to finish within about 10 minutes. Every step you take is a slow model call, so plan the few
commands you need first and batch them; do not explore code the diff does not touch.

1. Find how the project runs its tests (package.json scripts, Makefile, README) and install dependencies if needed.
2. Run only the tests that cover the changed files (the test files next to them, or the runner's "related"
   mode), plus the typecheck. Never run the whole suite, a build or end-to-end/browser suites: CI does that.
3. Write tests only when the diff adds behaviour and includes no tests for it at all: one focused test file,
   then run it. Do not commit: the loop commits what you leave in the checkout and reviews it again.
4. Decide whether the change needs manual QA in a browser: only when it visibly changes a page, a component or
   styling that unit tests cannot judge. Backend, library, config, prompt, docs or test-only changes do not.
