---
name: interface-review
description: Use when reviewing a branch or uncommitted change that touches pages, components or styles. Reports the interface problems the change introduced, ranked by what the user feels.
---

# Interface review

Review the change, not the whole app. The author asks "did I make this worse?".

## 1. Scope

1. Take the diff: `git diff origin/main...HEAD` plus uncommitted changes. Leave out lockfiles, snapshots and generated files.
2. Read the whole diff before judging any part of it.
3. Expand to affected surfaces: a changed shared component or style affects every screen that uses it. Find them with a search and name them.
4. State the scope at the top of the report: commits, files, screens.

## 2. Recon

Identify the framework, styling system, component library and tokens. Read what the project says about its own interface in CLAUDE.md and the rules. A documented convention settles questions of taste.

## 3. Review in this order

1. **Accessibility:** semantics, labels, keyboard, focus, contrast, alt text.
2. **States:** empty, loading, error, long content, narrow width.
3. **Layout:** alignment, spacing from the scale, overflow, touch targets.
4. **Wording:** actions, errors, consistent names.
5. **Type and colour:** sizes and colours from the system, hierarchy.
6. **Polish:** transitions, hover and focus styles, visual consistency.

Verify what can be verified: run the app in the dev environment when possible, compute contrast from the actual colour values, check both sides of the diff.

## 4. Classify every finding

- **Introduced:** did not exist before the change.
- **Regression:** existed and the change made it worse.
- **Pre-existing:** untouched by the change. Report at most three.

## 5. Report

A ranked list. Each finding: classification, severity (blocks users, hurts users, polish), file and line, what the user experiences, and the fix in the project's own idiom.

Verdict: `needs work` when anything introduced or regressed blocks or hurts users; otherwise `ready`. Name what you could not inspect; never imply that unseen screens were reviewed. Correctness, security and tests belong to the general code review: name such a concern once and move on.
