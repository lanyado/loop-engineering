---
title: Code review
label: CR
icon: review
---

Review for correctness bugs, missed requirements, security problems, missing tests and clear maintainability problems.
Include a security check of the change: injection, broken authentication or authorization, exposed secrets and unsafe handling of input.
Check that everything the request asks for is handled. Anything it asks for that the PR does not do is blocking.
Blocking means it must change before merge. Style preferences and optional ideas are non-blocking.
