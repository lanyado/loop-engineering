---
title: Manual QA
label: QA
icon: qa
---

Steps:
Be quick: you have 15 minutes. Check only what the diff changes; do not explore the rest of the app.

1. Start the app locally the way the README or package.json says (dev server in the background); wait until it answers.
2. With the Playwright tools, open the pages the diff changes and check that they render and the changed flow
   works, at a desktop size and, when the layout changed, at phone width. Check the browser console for errors.
3. Stop the dev server when done.
