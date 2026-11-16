---
description: Review the interface changes on this branch.
---

Review what the changes on this branch did to the interface (`git diff origin/main...HEAD` plus uncommitted changes). If the project has a `ui-reviewer` subagent, hand the review to it; follow the `interface-review` skill when it is available.

Check accessibility, missing states (empty, loading, error, long content, narrow width), layout, wording and consistency with the project's existing components. Report what the change introduced or made worse, ranked by what the user feels, with file and line and the fix. Do not edit anything. $ARGUMENTS
