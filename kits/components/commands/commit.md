---
description: Commit the current changes locally with a clear message.
---

Commit the work in progress. Do not push.

1. Run `git status` and `git diff` and read what changed.
2. If the changes cover several unrelated things, make one commit per logical change, staging files by name.
3. Never stage `.env` files, credentials, build output or files you did not intend to change.
4. Write the message: an imperative subject under 70 characters, a blank line, then why the change is needed. Follow the project's commit rule when it has one.
5. Show `git log --oneline -5` afterwards.

$ARGUMENTS
