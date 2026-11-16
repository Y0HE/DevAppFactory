---
description: Simplify the code changed on this branch without changing behaviour.
---

Simplify the code this branch changed (`git diff origin/main...HEAD`), or the scope given here: $ARGUMENTS

If the project has a `code-simplifier` subagent, hand this to it. Run the project's checks first and stop if they fail. Remove duplication, dead code, needless layers and deep nesting; improve unclear names. Do not change behaviour, public interfaces or code outside the scope. Run the checks after each simplification and report what changed and why it is equivalent.
