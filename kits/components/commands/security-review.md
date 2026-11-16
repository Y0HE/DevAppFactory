---
description: Review the current changes for security problems.
---

Review the changes that are not on `origin/main` yet (`git diff origin/main...HEAD` plus uncommitted changes) for security problems. If the project has a `security-reviewer` subagent, hand the review to it.

Trace input from outside to where it is used and check injection, access control, authentication, exposed secrets or data, unsafe defaults and new dependencies. Report only what could really be exploited, most serious first, with file and line, how it would be abused, and the fix. Say plainly when you find nothing. Do not edit anything, and never read `.env` files. $ARGUMENTS
