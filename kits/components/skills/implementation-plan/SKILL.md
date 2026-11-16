---
name: implementation-plan
description: Use when a feature touches several files or has several steps, before writing code. Produces a step-by-step plan someone else could follow.
---

# Implementation plan

Write the plan for an engineer who has not seen this codebase or this spec. They write good code once they know the exact files, names and tests. What they cannot know is what you decided.

## Before planning

1. Read the feature's description or spec and list its acceptance criteria.
2. Read the code it touches and find the closest existing feature. The plan follows its patterns.
3. If the feature covers several independent parts, say so and propose splitting it. Each plan must produce working, tested software by itself.

## The plan

Write it in the feature's file under `docs/features/`, below the description, or return it as your answer when no such file exists.

- **Goal:** one sentence.
- **Approach:** two or three sentences, with the reason for the choice.
- **Files:** every file to create or change, with what it is responsible for.
- **Tasks:** small steps in order. Each task has:
  - the files it touches,
  - the test to write first, with what it asserts,
  - the code to add, with real names, signatures and values from the spec,
  - the command that proves it, and the expected result.
- **Out of scope:** what this plan deliberately does not do.
- **Open questions:** only what the user must decide.

## Rules for tasks

- Each task ends with the project's checks passing and is worth its own commit.
- No placeholders: no "add validation", "handle errors" or "similar to task 2". Say which validation, which errors, and repeat what is needed.
- Names and types used in a later task match the ones defined in an earlier task.

## Check the plan

Go through the acceptance criteria one by one and point to the task that delivers each. A criterion without a task is a gap; fix the plan.
