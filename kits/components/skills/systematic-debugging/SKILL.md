---
name: systematic-debugging
description: Use when a test, check or build fails or the app behaves unexpectedly, before proposing any fix. Finds the root cause first.
---

# Systematic debugging

No fix before you know the cause. A fix that hides the symptom is a new bug.

## 1. Investigate

1. Read the whole error message and stack trace. Note file, line and error code.
2. Reproduce it with one command or a short list of steps. If it does not fail every time, collect more data; do not guess.
3. Check what changed: `git log --oneline -10`, `git diff`, new dependencies, configuration, environment.
4. When several components are involved (browser, API, database, container), log what enters and leaves each one and run once. Find the first place where the data is wrong and look only there.
5. Follow the wrong value backwards to where it was created. Fix it at the source, not where it was noticed.

## 2. Compare

Find similar code in the project that works. List every difference between it and the failing code, however small.

## 3. Test one hypothesis

1. Write it down: "X fails because Y".
2. Make the smallest change that would prove or disprove it. One variable at a time.
3. If it is wrong, undo the change, then form a new hypothesis. Do not stack fixes.

## 4. Fix

1. Write a test that fails because of the bug.
2. Fix the cause with one change. No "while I am here" improvements.
3. Run the new test and all project checks.
4. Remove the diagnostic logging you added.

## When to stop

After three failed fixes, stop fixing. Either the design is wrong or the problem is not understood. Report what you tried and what each attempt showed, and ask.

## Signs that you are guessing

- "Let me just try changing this."
- Several changes in one attempt.
- A fix proposed before the failure was reproduced.
- Adding a retry, a timeout, a default value or a `catch` to make the error disappear.
