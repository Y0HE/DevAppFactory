---
name: verification-before-completion
description: Use when about to say that work is complete, fixed or passing, and before committing. Requires fresh evidence for every claim.
---

# Verification before completion

Evidence before claims. If you have not run the command since your last change, you cannot say what it shows.

## Before any claim

1. **Identify** the command that proves the claim.
2. **Run** it in full, now, after the last change.
3. **Read** the whole output: exit code, number of failures, warnings.
4. **Compare** the output with the claim.
5. **Then** state the claim with the evidence, or state the real status.

| Claim | What proves it | What does not |
|---|---|---|
| Tests pass | The test check's output with 0 failures | An earlier run, "should pass" |
| Build works | The build check exits 0 | Lint passing |
| Bug is fixed | The original failing case now passes | The code was changed |
| Feature is done | Each acceptance criterion checked one by one | Tests passing |
| A subagent finished | The diff and the checks, looked at by you | Its report |

## In this project

- The checks are listed in CLAUDE.md. Run all of them, not only the one closest to your change.
- Acceptance criteria are in `docs/spec.md` or the feature's file in `docs/features/`. Go through them in order.
- After the checks you run, the factory runs the same checks without you. A claim that does not hold will be found.

## Stop when you notice

- The words "should", "probably", "seems to".
- Relief or satisfaction before the command has run.
- A commit about to be made without a fresh run.
- A partial check standing in for the whole.

## Report

Finish with three short lists: what you verified and how, what failed or is still open, what you could not verify.
