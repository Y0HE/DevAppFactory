# factory-host (prototype)

Runner that drives headless Claude Code sessions on the server. See `docs/DESIGN.md` section 5.

- `src/runner.ts`: starts `claude -p` with stream-json in and out, emits run events, classifies the final status.
- `hooks/guard.mjs`: `PreToolUse` hook injected into factory runs with `--settings`.
- `src/proto.ts`: scenarios to try against a live session.

```bash
npm install
npm test              # guard unit tests, no Claude login needed
npm run build
node dist/proto.js basic      # also: followup, interrupt, resume, policy
```

Scenarios use the `haiku` model by default (`PROTO_MODEL` overrides) and need a working `claude auth login` on the server.
