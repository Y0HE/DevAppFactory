# Security policy

DevAppFactory starts coding agents, runs Docker Compose and changes a gateway on the server it is installed on. Treat a vulnerability in it as a vulnerability in that server.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: on the repository page, open **Security**, then **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. You can expect a first answer within a week. Please give us reasonable time to fix the problem before you publish details.

## What counts

- Reaching the API or the host service without authentication, or from a deployed app.
- An agent run escaping its working folder, reading secrets, or widening its own permissions (`.factory/`, `.claude/settings*.json`, hooks, `.mcp.json`).
- Path traversal or command injection in any host operation.
- A deployment that gets host access the compose validation should have refused.
- Leaking stored deployment variables.

## Known limits, by design

- The UI has no login of its own and must be published behind an authenticating gateway.
- Agents run as the installing user and are not sandboxed; the allowlist and guard hook limit mistakes only.
- Content an agent reads (web pages, dependencies, issue text) can try to steer it. Kit rules ask agents to treat it as data, which reduces the risk and does not remove it.

Only the latest commit on `main` is supported.
