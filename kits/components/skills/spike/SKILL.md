---
name: spike
description: Use when it is unclear whether an approach, library or API can do what is needed, before committing to a design. A throwaway experiment that answers one question.
---

# Spike

A spike answers a question that reading cannot answer. Its output is a verdict, not code to keep.

## When not to spike

- The answer is in the documentation or the code. Read it.
- The approach is already known to work. Build it properly.

## Method

1. **Ask one question** that can be answered yes or no, in the form: given X, when Y, then Z. Example: given a 20 MB upload, when it is streamed to storage, then memory stays under 100 MB.
2. **Pick the riskiest question first.** If it fails, the others do not matter.
3. **Build the least code that answers it**, in `spikes/<name>/`. No tests, no error handling, no styling. Hard-code what is not part of the question. Run it through `docker compose` like everything else.
4. **Compare alternatives side by side** when the question is "A or B": same input, same measurement, one folder each.
5. **Stop at the answer.** Time-box it; a spike that grows is turning into the feature without its tests.

## Verdict

Write `spikes/<name>/README.md`:

- The question.
- The answer: works, works with limits, or does not work.
- The evidence: the command and its output, numbers where they matter.
- What was learned that the real implementation must respect.
- What was not tested.

## Afterwards

Spike code never goes into the app. Build the real thing from the verdict, with tests. Delete the spike folder, or keep only its README, before the feature is proposed for review. Do not add dependencies to the app's manifest for a spike.
