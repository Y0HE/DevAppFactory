---
description: Run every project check and report one pass or fail verdict.
---

Run every check listed under "Checks" in CLAUDE.md, in order, exactly as written. Keep going after a failure so the report covers all of them. Do not fix anything unless asked.

Report a table with one row per check: name, command, result, and for failures the first error with file and line. End with one line: `PASS` when every check exited 0, otherwise `FAIL` with the number of failing checks. $ARGUMENTS
