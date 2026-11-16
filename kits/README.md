# Kit library

The seed library DevAppFactory copies to `~/factory/kits` on first start. After that, the Kits page lists what this folder has that the library lacks ("Updates from the factory") and copies the chosen files in as pending changes. Structure and rules: [docs/DESIGN.md](../docs/DESIGN.md), section 6.

## What is in it

| Kind | Components |
|---|---|
| Kits | `base` (minimal), `standard` (full working rules, builder and reviewer, core skills) |
| Teams | `delivery`, `discovery`, `quality`, `frontend`, `maintenance` |
| Subagents | implementer, reviewer, check-fixer, architect, code-explorer, debugger, test-engineer, security-reviewer, silent-failure-hunter, reality-checker, ui-reviewer, code-simplifier, doc-updater |
| Skills | test-driven-development, systematic-debugging, verification-before-completion, receiving-code-review, implementation-plan, prime-codebase, spike, frontend-design, interface-review, e2e-playwright, database-migrations |
| Rules | factory-workflow, docker-first, commit-messages, testing-first, security-basics, accessible-html, minimal-changes, evidence-first, root-cause-first, error-handling, untrusted-content, documentation, ui-quality, coding-style, typescript-style |
| Commands | review-changes, validate, commit, debug, explore, plan-feature, tdd, security-review, ship-check, simplify, update-docs, review-ui |
| Hooks | `session-context` (SessionStart), `checks-before-stop` (Stop), `protect-secrets` (PreToolUse) |
| MCP servers | `context7` (current library documentation) |
| Workflows | `ci-checks` (runs the project's own checks on GitHub Actions) |

A team is this library's form of a Claude Code plugin: a named bundle of subagents, skills, commands, rules, hooks and MCP servers that is assigned to projects as one unit.

## Where the ideas come from

Every component here is written for DevAppFactory (Docker-first, agents never push, checks decide). The methods were adapted from these projects, all read on 2026-11-16:

| Source | What was taken from it |
|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) (MIT) | Root cause before fixes, red-green-refactor, evidence before completion claims, verifying review feedback, plans without placeholders |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | The explorer, architect and reviewer split of `feature-dev`; the silent-failure and simplifier reviewers of `pr-review-toolkit`; local commit command; the Context7 MCP server |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (MIT) | Reality checker (default "needs work"), minimal-change discipline, specialist roles for testing and security |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) (MIT) | Check fixer with minimal diffs, doc updater, common coding-style and error-handling rules, treating fetched content as data |
| [coleam00/skills](https://github.com/coleam00/skills) (MIT) | Hooks as guarantees: checks before stop, secret guard, session-start context; one-verdict validation; codebase priming |
| [jakubkrehel/skills](https://github.com/jakubkrehel/skills) (MIT) | Change-scoped interface review with introduced, regression and pre-existing findings; review order from accessibility to polish |
| [anthropics/skills](https://github.com/anthropics/skills) | Frontend design that avoids template defaults; browser testing with Playwright |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT) | Spike: a throwaway experiment that answers one question with a verdict |

## Tests

`apps/host/test/kits.test.mjs` validates this library and exercises the hook scripts (`npm test` in `apps/host`).
