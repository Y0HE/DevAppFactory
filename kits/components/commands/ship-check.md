---
description: Decide with evidence whether the current feature is ready for review.
---

Decide whether the work on this branch is ready to be proposed for review. If the project has a `reality-checker` subagent, hand this to it.

1. List the acceptance criteria from the feature's file in `docs/features/` or from `docs/spec.md`.
2. Run every check listed in CLAUDE.md now and read the output.
3. For each criterion, find evidence that it holds: a test, a command's output, a response from the running app.
4. Confirm the working tree is committed and that the diff contains nothing the task did not need.

Report one row per criterion (met, not met, not verified) with its evidence, then `Verdict: ready` or `Verdict: needs work` with what is missing. Do not fix anything unless asked. $ARGUMENTS
