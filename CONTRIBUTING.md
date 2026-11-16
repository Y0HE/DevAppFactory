# Contributing

Thanks for helping. This project is young, so please open an issue to discuss anything larger than a small fix before writing it.

## Working on it

- `apps/host`: `npm install && npm run build && npm test`. It must keep working on Node.js 18 and use only Node built-ins plus `yaml`.
- `apps/server` and `apps/web`: built and type-checked by `docker build .` (Node.js 24 in the image).
- `kits/`: the seed library. `npm test` in `apps/host` validates it and exercises the hook scripts.

## Rules

- **Nothing server-specific in code.** No user names, home paths, domains or host names. Settings come from the environment and are documented in `.env.example` and the README table.
- **`factory-host` exposes fixed operations only.** Validate every name and path, build commands from argument arrays, never pass text to a shell.
- **Agents propose, checks decide.** Pushes, pull requests, merges, deploys and gateway changes are done by factory code, never by an agent.
- Tests for behaviour you add or change; a failing test first for a bug.
- Update `docs/DESIGN.md` when behaviour or a decision changes.
- Tabs for indentation, as in the existing code. Commit subjects in the imperative, under 70 characters, with a body that says why.

## Pull requests

Keep them small and about one thing. Say what you verified and what you could not verify. By contributing you agree that your work is released under the project's licence.
