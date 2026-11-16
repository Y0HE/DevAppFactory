---
description: Find the root cause of a failure before fixing it.
---

Investigate this problem: $ARGUMENTS

If the project has a `debugger` subagent, hand the problem to it. Otherwise follow the `systematic-debugging` skill when it is available: reproduce the failure, read the whole error, check recent changes, state one hypothesis and test it with the smallest experiment. Do not change application code until you can say in one sentence why it fails. Then add a test that fails because of the bug, fix the cause, and run the project's checks.
