---
description: Plan how to build a feature before writing code.
---

Plan this feature without implementing it: $ARGUMENTS

1. Read the spec or description and list the acceptance criteria. Ask about anything essential that is missing before planning.
2. Explore the code the feature touches (with the `code-explorer` subagent if the project has one).
3. Design it (with the `architect` subagent if the project has one), following the `implementation-plan` skill when it is available: files, tasks in order, the test for each task, and what is out of scope.
4. Show the plan and wait for approval. Do not edit application code.
