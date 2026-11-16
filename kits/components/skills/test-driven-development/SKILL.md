---
name: test-driven-development
description: Use when implementing a feature or fixing a bug, before writing the implementation. Write the failing test first, then the code.
---

# Test-driven development

A test you never saw fail proves nothing: you do not know whether it tests the right thing.

## The cycle

1. **Red.** Write one small test for one behaviour, named for that behaviour. Use the real code through its public interface.
2. **See it fail.** Run it. It must fail because the behaviour is missing, not because of a typo or an import error. If it passes, it tests something that already exists; change the test.
3. **Green.** Write the simplest code that makes this test pass. Nothing for later.
4. **See it pass.** Run it together with the rest of the tests. Everything is green and the output is clean.
5. **Refactor.** Remove duplication and improve names while the tests stay green. No new behaviour in this step.
6. Next behaviour, next test.

## Rules

- Code written before its test is deleted and written again from the test. Keeping it "as reference" means testing after.
- Bug fix: first a test that reproduces the bug, then the fix.
- Run tests the way CLAUDE.md lists the checks, through `docker compose` when the project says so.
- Mock only what is slow, external or random. A test of a mock tests nothing.
- Never weaken or delete a test to get to green.

## What to test

- Each acceptance criterion of the feature.
- The edges: empty, one, many, too long, wrong type, duplicate.
- The failure paths: invalid input, not authorized, dependency down.

## When a test is hard to write

The design is telling you something. Hard to set up means too much coupling; needing many mocks means the unit does too much. Simplify the interface instead of the test.
