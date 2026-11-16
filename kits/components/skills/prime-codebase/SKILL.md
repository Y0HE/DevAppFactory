---
name: prime-codebase
description: Use at the start of work in an unfamiliar project or area, before planning or editing. Builds a quick and accurate picture of how the code is organised.
---

# Prime codebase

Spend a few minutes reading before the first edit. The goal is a map, not a tour.

## Read in this order

1. `CLAUDE.md` and `.claude/rules/`: how to work here and which checks exist.
2. `docs/idea.md`, `docs/spec.md`, `docs/architecture.md` when present: what the app is for and what was decided.
3. `docker-compose.yml`: the services, how the app starts, which ports and volumes.
4. The manifest (`package.json`, `pyproject.toml`, `go.mod`): language, framework, scripts, main dependencies.
5. `git log --oneline -15` and `git status`: what changed recently and what is in progress.
6. The folder tree two levels deep, then the entry point of the app and one complete feature from the interface down to storage.
7. One existing test file: how tests are written and run.

## Write down, briefly

- **Stack:** language, framework, database, test runner.
- **Layout:** where routes, components, data access and tests live.
- **How to run and check:** the exact commands.
- **Conventions:** naming, error handling, how configuration is read.
- **For this task:** the files you will most likely touch and the existing feature most similar to it.

## Rules

- State only what you read. Mark anything inferred as inferred.
- Stop when you can name the files the task touches. Do not read the whole repository.
- If the project has a `code-explorer` subagent, give it the deep trace of one area and keep your own context for the task.
