# DevAppFactory design

Status: 2026-11-15. Milestone 1 (skeleton) is implemented and running at https://factory.example.com; see section 13. The rest is design.

## 1. Purpose

DevAppFactory is a web application that takes an app from idea to a running deployment on this server, with Claude Code agents doing the work and deterministic checks deciding whether each step passed.

From the web UI the user can:

1. Create a project: GitHub repo, local clone, scaffold, gateway site.
2. Specify the app idea and the Claude Code features the project uses (rules, skills, subagents, hooks, MCP servers, memories).
3. Monitor and control agents, project phases and status.
4. Add features, validate them and push them to GitHub.
5. Manage CI, CD and GitHub Actions workflows.
6. Write, create and improve kits (the reusable Claude Code configuration) from inside the UI.
7. Develop alongside the agents: open the same project folder in an editor or in Claude Code, run and check the app, and switch AI features on or off per project.

## 2. Decisions taken

| Topic | Decision |
|---|---|
| Hosting | Local-first, single user, on this server |
| Packaging | The factory web UI and API, and every app (dev, test services, preview, production) run in containers. App toolchains (Node, package managers, test runners) live in the app's containers, not on the host |
| Where agents run | Claude Code agents run directly on the server, as the server user, inside the project folder, exactly as when Claude Code is used by hand |
| Shared workspace | The project folder is shared by agents and the user. The user can open it in an editor or Claude Code at any time and develop, run and check the app |
| Project location | New projects live in `~/factory/projects/<name>`. Existing projects stay where they are and are not managed by the factory |
| First kit | Next.js + Postgres |
| Merges | Manual in v1 |
| Agent runtime | The Claude Code already installed on the server (`~/.local/bin/claude`), with its existing subscription login |
| Language | TypeScript for backend and frontend |
| Deploy target | This server: Docker Compose per app, published through a Caddy gateway at `<name>.example.com` |
| Gateway | A Caddy gateway (the bundled one, or another at `GATEWAY_DIR`) is integrated as a system project, driven through its `scripts/gateway.sh` |
| Approval gates | Human approval at spec, at diff review before the PR, and before production deploy |
| Agent permissions | Edits and a command allowlist inside the project folder, enforced by Claude Code settings and a hook; no interactive prompts for factory-started runs |
| Concurrency | Queue with a cap of 2 concurrent agent runs to start |

## 3. Principles

1. **Agents propose, checks decide.** A run is never "done" because the agent said so. Build, lint, tests, CI and health checks decide.
2. **Files in git are the truth.** Specs, kits, workflows and Claude configuration are files in repositories. The database holds state and pointers only.
3. **A project works without the factory.** Everything the factory writes (`.claude/`, `docker-compose.yml`, workflows) is standard, so the repo can be opened in plain Claude Code.
4. **Agents and the user share one workspace.** The kit is copied into the project folder, so an agent started by the factory and a Claude Code session started by hand behave the same way.
5. **Change requests are first-class.** The same feature lifecycle builds the first version and every later change.

## 4. Architecture

```
Browser ── https://factory.example.com (Caddy, basic auth)
              │
   ┌──────────▼───────────┐            ┌──────────────────────────────┐
   │ factory-app          │  local API │ factory-host (on the server) │
   │ (container)          ├───────────►│ runs as the server user, systemd service │
   │ UI + API             │◄───────────┤ Claude Code agents           │
   │ orchestrator, SQLite │   events   │ git, gh, docker compose      │
   └──────────────────────┘            │ gateway.sh                   │
                                       └──────────────┬───────────────┘
                                                      │
        ~/factory/projects/<name>  ◄──────────┤  also opened by the user
        app containers (dev, preview, prod) ◄─────────┘  (editor, Claude Code, terminal)
```

| Part | Runs | Does |
|---|---|---|
| `factory-app` | Container, behind Caddy | Web UI, REST API, orchestrator state machines, SQLite, live event stream to the browser |
| `factory-host` | On the server as a systemd user service | Everything that must touch the server: starts Claude Code agents, runs git and `gh`, runs `docker compose` for projects, calls `gateway.sh`, reads and writes project and kit files |
| App containers | Docker Compose per project | The app's dev server, test services, preview and production |

Why a host service: a container cannot start processes on the server, and agents must run on the server in the real project folder with the existing Claude Code login. `factory-host` is deliberately small: it exposes a fixed set of operations (start run, send message, stop run, git operations, compose operations, gateway operations, file read/write under the factory directory) and nothing generic such as "run this shell command".

Connection: `factory-host` listens on a Unix socket in `~/factory/run/`, which is mounted into `factory-app`. Nothing is exposed on a network port.

`factory-host` is written in TypeScript. For now it is compiled with `tsc` and run by the server's own Node 18 as a systemd user service (`deploy/install-host.sh`); it uses only Node built-ins plus a YAML parser. Packaging it as a single self-contained executable remains the goal, so it stops depending on the server's Node version.

### 4.1 Filesystem layout

```
~/factory/
  data/factory.db                    SQLite
  run/host.sock                      factory-app ↔ factory-host
  kits/                              kit and component library (a git repo)
  projects/<name>/                   main clone: the shared workspace, kit copied in (.claude/, CLAUDE.md)
  worktrees/<name>/<feature-slug>/   git worktree per feature, on branch feature/<slug>
  deploy/<name>/<env>/               checkout pinned to the deployed commit, plus env files
  runs/<run-id>/                     raw transcripts and check logs
```

Projects that already exist elsewhere on the server stay in place and are not managed by the factory.

### 4.2 Configuration

Nothing in the code names a user, a home path, a domain or a host. Everything that differs between servers is a setting in `.env` at the repository root, documented in `.env.example` and in the README table. `deploy/install-host.sh` creates the file, adds the required settings that are missing (secret key, factory home, user and group) and never changes a value that is set. The systemd unit is generated at install with the repository's real location and loads `.env` through `EnvironmentFile`; Docker Compose reads the same file and refuses to start when a required setting is missing. CI fails on a hard-coded home path.

### 4.3 Technology

| Layer | Choice |
|---|---|
| Repo layout | `apps/web`, `apps/server`, `apps/host`, each with its own `package.json` (npm). pnpm workspaces and a shared types package are deferred: pnpm is not installed on the server and `apps/host` must build there |
| Backend | Node 24 (in the container), Fastify |
| Host service | TypeScript, systemd user unit, HTTP over a Unix socket |
| Frontend | React + Vite, Monaco editor for kits/specs/workflows, diff viewer, web terminal |
| Live updates | Server-sent events from an append-only event table |
| Database | SQLite through Node's built-in `node:sqlite` (no native module to compile); an ORM can be added when the schema grows |
| GitHub | `gh` CLI on the server, already logged in |
| Agents | Claude Code headless (stream-json in and out), wrapped behind a Runner interface |

## 5. Agent runner

### 5.1 Interface

```ts
interface Runner {
  start(opts: { cwd: string; prompt: string; policy: PermissionPolicy; kitAgent?: string }): RunHandle
  send(runId: string, message: string): void      // user steering mid-run
  interrupt(runId: string): void
  resume(runId: string, prompt?: string): RunHandle // continues the Claude session
  events(runId: string): AsyncIterable<RunEvent>
}
```

`factory-host` spawns `claude -p --output-format stream-json --input-format stream-json` with the feature worktree (or the project folder) as working directory. These flags are confirmed present in the installed Claude Code 2.1.296. Because the kit is already copied into the folder, the agent picks up `CLAUDE.md`, rules, skills, subagents, hooks and MCP servers the same way a hand-started session does.

Deterministic checks (build, lint, test) are the kit's commands, run by `factory-host` without an agent. They execute inside the app's containers through `docker compose`.

### 5.2 Authentication

Agents use the Claude Code subscription login stored on the server for the server user. No API key. Factory runs and the user's own terminal sessions share the same account, settings directory and session history; a factory session can be resumed by hand with `claude --resume`, and the reverse.

The server needs its own login: a one-time `claude auth login` as the server user. Sessions opened from the Claude desktop app do not count, because the app supplies credentials over its own connection and a process started by `factory-host` gets none of that. On a small subscription plan the usage window is short; long or parallel agent runs will hit it.

The runner detects this case and ends the run with status `auth_required`, so the UI can show "Claude login needed" instead of a generic failure.

### 5.3 Usage limits

Subscription limits are shared with the user's own Claude Code work.

- Global queue, 2 concurrent runs by default, configurable.
- A "limit reached" result puts the run in `paused_limit`; the orchestrator resumes the same session after the reset time.
- The UI shows tokens and duration per run, feature and project (no dollar cost).

### 5.4 Permission policy

Agents run as the server user on the server, so there is no container boundary around them. Control comes from Claude Code's own mechanisms, written into the project by the kit:

- **`.claude/settings.json`** (committed): allow rules for edits inside the project and for the kit's command allowlist; deny rules for reading secrets (`.env*`, `deploy/`), `git push`, `sudo`, and Docker commands other than `docker compose` for this project.
- **A `PreToolUse` hook** (`apps/host/hooks/guard.mjs`) passed to each factory-started run with `--settings`: rejects file access outside the run's working directory, secret files, and blocked commands. Because it is injected per run, the user's own sessions never load it and nothing is installed in user-level settings.
- **`--permission-mode acceptEdits` with `--permission-prompts none`:** edits are accepted, allowlisted commands run, and anything that would normally prompt is denied automatically.
- **The allowlist comes from the kit**, recorded as `allowed_commands` in `.factory/project.yml` and passed to each run with `--allowedTools`. Agents cannot edit that file or `.claude/settings*.json`.
- **Hooks and MCP servers are programs outside the guard.** They reach a project only from the library, and only in a version the user has committed there. Agents cannot write `.claude/hooks/` or `.mcp.json`. Each run is started with `--strict-mcp-config` and the project's `.mcp.json`, so it sees the project's MCP servers and none from the server user's own account or plugins; the tools of those servers are allowed with `mcp__<id>`.
- **Factory-started runs never prompt.** A denied action is reported to the agent, which must find another way or stop and ask the user through the UI.
- **Pushes, PRs, merges, deploys and gateway changes** are done by `factory-host` code, not by agents.

Limit of this approach: the allowlist is a guard against mistakes, not a security sandbox. An agent that can run `docker compose` and project scripts could in principle affect other things on the server. This is the accepted trade-off for running agents in the real workspace; a dedicated Unix user for agents is a possible later hardening step.

### 5.5 Verified behaviour of headless Claude Code

Checked on 2026-11-16 against Claude Code 2.1.296 with `apps/host/src/proto.ts`:

| Behaviour | Result |
|---|---|
| Event stream | `system/init` carries the session ID; then `assistant`, `user` (tool results), `rate_limit_event`, and a final `result` |
| Follow-up message mid-turn | Folded into the running turn; one `result` for both. With `--replay-user-messages` each message is echoed when taken up, which is how the runner knows nothing is left unprocessed |
| Process lifetime | With streamed input the process stays alive after `result` until stdin is closed |
| Interrupt | A `control_request` with subtype `interrupt` is acknowledged, the turn ends with `result/error_during_execution`, and the process exits within a second |
| Resume | `--resume <session-id>` in a new process continues with full memory of the earlier turns |
| Hook via `--settings` | Fires for every tool call; a deny decision is reported to the agent as a tool error and it carries on |
| `--permission-prompts none` | Commands not on the allowlist are denied with a `system/permission_denied` event |
| Bash and the working directory | Claude Code itself refuses Bash reads and writes outside the working directory in this mode; Bash writes inside it are accepted without an allowlist entry |
| Secret files | The hook blocks the file tools and commands that name `.env` files. A command can still reach one indirectly (glob, script), so secrets must never be stored in project folders |
| Workspace trust | Claude Code ignores `permissions.allow` in a project's own `.claude/settings.json` until its trust dialog has been accepted in that folder. The factory therefore passes the allowlist on the command line, read from `allowed_commands` in `.factory/project.yml`, and the hook blocks agents from writing `.factory/` and `.claude/settings*.json` |
| Usage limits | `rate_limit_event` reports status, limit type and reset time on every turn; the shape of an actual limit-reached result has not been observed |

### 5.6 How a run flows through the system

1. The browser posts a task to `factory-app`, which stores a run as `queued`.
2. A queue starts it when fewer than 2 runs are active (`MAX_CONCURRENT_RUNS`).
3. `factory-app` asks `factory-host` to start Claude Code in the project folder, then follows the host's event stream and stores every event in SQLite.
4. The browser follows the run over server-sent events: stored events first, then live ones. It can send a message, stop the run, or resume a finished run's Claude session as a new run.
5. `factory-host` also writes each run's raw events to `~/factory/runs/<id>/events.jsonl`.

If `factory-app` restarts during a run, the run is marked failed, the agent is stopped, and it can be resumed. A run that ends at a usage limit gets status `paused_limit` with the reset time; resuming is manual for now.

### 5.7 Cleanup

Runs, worktrees and Claude sessions accumulate in `~/factory` and `~/.claude/projects`. The Cleanup page lists them with their size and deletes what is ticked.

| What | Where it lives | Deleting it | Kept (cannot be ticked) while |
|---|---|---|---|
| Agent run | Row and events in SQLite, raw log in `runs/<host-run-id>/` | Removes all three; the run leaves every list | It is queued or running, its feature is not merged or cancelled, or it is the latest spec or plan run of its project (the factory resumes those) |
| Run log without a run | `runs/<id>/` with no row pointing to it | Removes the folder | The host still has that run going |
| Worktree | `worktrees/<project>/<slug>/` | Removes the folder with any uncommitted files; the local branch stays | Its feature is not merged or cancelled |
| Claude session | `~/.claude/projects/<folder>/<session-id>.jsonl` plus its subagent transcripts, only for folders inside the factory home | Removes the files; runs that used it can no longer be resumed | A run that must stay uses it |

- `factory-host` only reports what is on disk and deletes by validated name (`cleanup.ts`); `factory-app` decides what is still needed, because it knows the runs and features.
- **Every attempt is logged** in the `cleanup_log` table (time, kind, target, detail, bytes freed, and refusals with their reason). The page shows the latest 200 entries.
- Not covered: deployment folders, project folders, Docker images and volumes.

### 5.8 Run events

Every Claude Code message and tool call becomes a row in `events` (run, sequence, type, JSON payload). The UI transcript, replay, token totals and the orchestrator all read from this one stream. Raw output is also kept in `runs/<run-id>/` for debugging.

## 6. Kits and components

A kit is what turns a blank repo into a project Claude Code can work in well. Kits are edited in the UI and stored as files in `~/factory/kits` (its own git repo, so every change is versioned and can be pushed to GitHub).

### 6.1 Structure

```
kits/
  components/
    rules/<id>/rule.md
    skills/<id>/SKILL.md ...
    agents/<id>.md
    hooks/<id>/hook.json + script
    mcp/<id>.json
    workflows/<id>.yml          GitHub Actions templates
    scaffolds/<id>/             app template: source, Dockerfile, docker-compose.yml
  kits/<kit-id>/kit.yml         a preset: which components, which scaffold, check commands
```

`kit.yml` example:

```yaml
name: nextjs-postgres
version: 3
scaffold: nextjs-postgres
components:
  rules: [typescript-style, testing-first, security-basics]
  skills: [db-migrations, e2e-playwright]
  agents: [spec-writer, implementer, reviewer, ci-fixer]
  hooks: [format-on-edit]
  mcp: []
  workflows: [ci-node]
checks:
  # run inside the app's dev container, so no toolchain is needed on the server
  install: docker compose run --rm app pnpm install --frozen-lockfile
  build: docker compose run --rm app pnpm build
  lint: docker compose run --rm app pnpm lint
  test: docker compose run --rm app pnpm test
runtime:
  port: 3000
  health: /api/health
allowed_commands: ["docker compose", make, git]
```

Components are the pick-and-mix library; a kit is a named preset. When creating a project the user picks a kit, then adds or removes individual components.

### 6.2 Applying a kit

The factory copies the selection into the project folder: `CLAUDE.md` (assembled from rules plus project facts), `.claude/rules/`, `.claude/skills/`, `.claude/agents/`, `.claude/settings.json`, `.mcp.json`, `.github/workflows/`, and the scaffold. It records kit name, version and the enabled components in `.factory/project.yml` in the repo. The scaffold's `docker-compose.yml` defines the app's dev service (source mounted, hot reload), its test services and its production build.

### 6.3 Editing kits in the UI

The Kits page works on the library in `~/factory/kits`, which is a git repository. Every change, by hand or by an agent, is first an uncommitted change there; the page shows it as a diff, and nothing takes effect for new projects' history until the user commits it.

- **Browse and edit:** kits and components by kind, the files of the selected item, and a text editor. A plain text editor for now; Monaco is deferred.
- **Create:** a new component of any kind or a new kit, from a template or as a copy of an existing kit.
- **Validate:** kit manifests must parse and refer only to components that exist; rules must not be empty; subagents and skills need `name` and `description` frontmatter; workflows must be valid YAML; hook and MCP definitions valid JSON. Commit is refused while validation fails.
- **With AI:** a task for an agent whose working folder is the library. It cannot run commands or commit; its edits show up as pending changes to review, commit or discard, like manual ones.
- **Promote from project:** the project page compares each enabled component in the project with the library copy and lists project-only rules, subagents, skills and workflows. "Promote" copies the project's version into the library as a pending change.
- **Upgrade a project:** when the library's kit version is higher than the project's, the project page offers an upgrade. It opens a feature whose branch the factory itself fills: enabled components are refreshed from the library, and `kit_version`, `checks`, `runtime` and `allowed_commands` in `.factory/project.yml` are updated, with the command allowlist in `.claude/settings.json`. Scaffold files (the app's own code and compose file) are never overwritten. The feature then goes through checks, review and pull request like any other.

### 6.4 Teams

A team is a named set of subagents together with what they work with. It lives in the library as `teams/<id>/team.yml`. The project chooses its teams, not the other way round: one or more when it is created, and any change afterwards on its own page. Any number of projects can have the same team.

```yaml
name: delivery
version: 2
description: Builds features and reviews them before they reach you.
lead: implementer            # optional: the member suggested to lead a run
components:
  agents: [implementer, reviewer]     # the members; at least one
  rules: [commit-messages]
  commands: [review-changes]
  skills: []
  hooks: []
  mcp: []
```

- **Component kinds:** subagents, rules, skills, commands (`components/commands/<id>.md`, copied to `.claude/commands/`), hooks and MCP servers. A hook is `components/hooks/<id>/hook.json` (`{ event, matcher, command }` or a list) with its scripts; installing it copies the folder to `.claude/hooks/<id>/` and rebuilds the `hooks` part of `.claude/settings.json` from the hook folders present. An MCP server is `components/mcp/<id>.json`; installing it adds an entry to `.mcp.json`. Kits and the per-project switches use the same kinds.
- **Teams page:** put a team together from the library with checkboxes, pick a lead, and save (each change raises the version and is a pending change in the library). It shows which projects use the team and at which version, with links to them; it does not assign.
- **At creation:** the new project form lists the library's teams and requires at least one when the library has any. Their components are installed with the kit and are part of the project's first commit. Hooks and MCP servers of a chosen team must be committed in the library, as for a kit.
- **Assigning on the project page** copies the team's components into the project, records the team with its version and component list under `teams:` in `.factory/project.yml`, and commits and pushes that like a feature switch. Each project is its own commit in its own repository.
- **Updating:** when the library's version differs from the project's, the project page offers an update, which re-copies the components and removes those the team no longer has.
- **Removing** deletes the team's components from the project, except those another team or an individual switch still asks for. The record in the project is enough for this, so a team deleted from the library can still be removed.
- **Switches and teams:** a component that comes with a team shows as such on the project page and cannot be switched off there. A kit upgrade leaves team components alone.
- **How a team works in a run:** Claude Code makes the subagents in `.claude/agents/` available to whichever agent leads the run, which calls on them by their descriptions. A one-off run can be led by a chosen member (`--agent`); a resumed run keeps its lead. Feature builds and the spec and plan phases are still led by the general agent.

### 6.5 Seed library contents

The seed library in `kits/` ships two kits (`base`, `standard`), five teams (`delivery`, `discovery`, `quality`, `frontend`, `maintenance`) and the subagents, skills, rules, commands, hooks, MCP server and workflow they use; `kits/README.md` lists them with the projects their methods were adapted from. A team plays the role of a Claude Code plugin: one bundle assigned as a unit.

- **Hooks are Node scripts** (`.mjs`, built-ins only), because Node is the one runtime the server has. `protect-secrets` gives hand-started sessions the secret and `rm -rf` protection that factory runs get from the guard; unlike the guard it fails open. `checks-before-stop` runs the project's `checks` when an agent wants to finish and blocks the stop on a failure, at most three times in a row, skipping code it has already seen pass; it applies the same rule as the factory (no shell, allowed commands only). `session-context` tells the agent the branch, uncommitted files and recent commits.
- **The seed is copied only on first start; after that it is offered, not applied.** The Kits page compares the seed with the library and lists, under "Updates from the factory", each seed file the library lacks (`new`, ticked by default) or has with other content (`differs`, which may equally be an edit made in the library, so it is replaced only when ticked). "Copy" puts the chosen files into the library as pending changes to review and commit. It never deletes, and a file that exists only in the library is not reported. A component deliberately deleted from the library therefore keeps showing as `new`.
- `apps/host/test/kits.test.mjs` validates the seed library and tests the hook scripts and the seed comparison. Not verified: the hooks inside a real Claude Code run, the `ci-checks` workflow on GitHub Actions, and the `context7` server from a factory run.

### 6.6 Memories

Project memory is `CLAUDE.md` and `.claude/rules/` in the repo (shared, versioned) plus Claude Code's own per-project memory under `~/.claude/projects/`. The UI lists and edits both for each project.

## 7. Project lifecycle

### 7.1 Create project

1. Validate name (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, unused on GitHub, on disk and in the gateway).
2. `gh repo create <owner>/<name>` (private by default), clone into `~/factory/projects/<name>`.
3. Copy the kit, the scaffold and the chosen teams' components into the folder, commit, push.
4. Create the project's Docker network and gateway sites, and start the dev environment (section 9).
5. Register in the database, phase = `spec`.

### 7.2 Phases

| Phase | What happens | Exit gate |
|---|---|---|
| Spec | An agent reads `docs/idea.md`, asks questions when essentials are missing, and writes `docs/spec.md` with numbered acceptance criteria | User approves the spec |
| Plan | An agent writes `docs/architecture.md` and `docs/plan.json`, a list of small features with dependencies | User approves the plan |
| Build | Planned features run through the feature pipeline in dependency order | All planned features merged |
| Release | The app is on preview; the user promotes it | A production deployment is live |
| Operate | App is live; new features and fixes use the same pipeline | Ongoing |

How the spec and plan phases work:

- **A conversation, not a form.** Each phase is one Claude session in the project folder. The agent's last message (questions, or a summary of what it wrote) is shown beside the document, and the user's reply resumes the same session. This repeats until the user approves.
- **The agent writes, the factory commits.** The agent only edits files under `docs/`. On approval `factory-host` commits exactly those files and pushes them, so feature branches (which start from `origin/main`) contain the spec.
- **The plan is data.** `docs/plan.json` is an array of `{ "title", "description", "depends_on": [titles] }`. The factory validates it (1 to 20 features, unique titles, dependencies that exist, no cycles) before the plan can be approved. On approval each entry becomes a feature in status `planned`.
- **Build order.** A planned feature is ready when everything it depends on is merged. With "start planned features automatically" on (the default), the factory starts the next ready feature whenever none of the project's planned features is being built or checked. One at a time, because features without a declared dependency can still touch the same files. The user still reviews and merges each one.
- **Phases do not lock anything.** Features, agents and deployments work in every phase; a project can skip the spec entirely. The phase is a guide to what comes next.
- The prompts for the spec and plan agents are built into the factory for now. Moving them into kit subagents is part of milestone 7's follow-up.

### 7.3 Feature pipeline

A feature is one change to a project: it gets its own branch and folder, an agent builds it, deterministic checks judge it, the user reviews the diff, and it reaches `main` through a pull request.

```
building ──► checking ──► review ──► pr_open ──► merged
   ▲            │           │           │
   └── fix ◄────┘           │           │        needs_attention   (stuck; the user decides)
   └── changes requested ◄──┴───────────┘        cancelled         (discarded)
```

| State | Who acts | What happens |
|---|---|---|
| (create) | User | Title and description. `factory-host` fetches `origin`, creates the worktree `~/factory/worktrees/<project>/<slug>` on branch `feature/<slug>` from `origin/main`, writes the description to `docs/features/<slug>.md` and commits it |
| `building` | Agent | An agent run in the worktree implements the spec and commits locally |
| `checking` | `factory-host` | Leftover uncommitted work is committed by the factory. Every kit check runs in the worktree, with no agent involved. Results are stored per round |
| fix loop | Agent | When a check fails, the same Claude session is resumed with the failing output. After 3 failed rounds the feature moves to `needs_attention` |
| `review` | User | Diff against `origin/main`, check results and transcripts. Approve, or request changes (resumes the session with the user's text and goes back to `building`) |
| `pr_open` | `factory-host` | On approval the branch is pushed and the pull request opened. Its state and CI checks are polled every 30 seconds. Requesting changes here pushes new commits to the same pull request after they pass checks and review |
| `merged` | User | Merge from the UI (squash). The remote branch, worktree and local branch are removed, and the main folder is fast-forwarded when it is clean. A merge done on GitHub is detected by the poll and cleaned up the same way |
| `needs_attention` | User | Reached when the agent stops, fails, hits a limit, makes no changes, or exhausts the fix loop. The user can send an instruction, re-run checks, or discard |
| `cancelled` | User | Discard closes the pull request if there is one and deletes the worktree and both branches |

Rules:

- Agents never push. Push, pull request, merge and cleanup are fixed commands run by `factory-host`.
- Each feature has its own worktree, so features of one project can be built in parallel. Dependencies between features are not modelled yet.
- The dev URL can serve a feature: "Preview" restarts the project's compose stack from the feature's worktree under the same compose project name; starting the dev environment from the project page switches it back.
- A feature's spec is its description: typed by the user, or written by the plan agent for planned features.
- CI failures are shown but not fixed automatically yet (milestone 8).
- Features start from `origin/main`, not from the project folder. Commits or edits that exist only in the project folder are not included, and the feature says so when it is created. After a merge the project folder is fast-forwarded, or rebased when it has local commits; it is left alone when it has uncommitted changes or a conflict.

### 7.4 Developing by hand alongside the agents

The project folder is an ordinary git clone with the kit inside it, so the user can work in it at any time:

- **Open it:** each project page shows the path and has "Open in VS Code" (remote link to the server), a web terminal in the project folder, and the command to start Claude Code there.
- **Run and check it:** the dev environment is the project's own `docker compose` stack with the source mounted, served at `<name>-dev.example.com`. Checks are the commands under `checks` in `.factory/project.yml`; they run without a shell and must start with a command from `allowed_commands`. The UI has start, stop, restart, logs, and buttons for each kit check (build, lint, test). By default it serves the main project folder; it can be pointed at a feature worktree to try an agent's work before approving it.
- **Switch AI features on or off:** the project's "AI features" screen lists every rule, skill, subagent, hook, MCP server and workflow from the library with a toggle, and allows editing them for this project only. Switching one copies the component into the project (or removes it), updates `.factory/project.yml`, and commits only those paths. The commit is pushed when the project folder is otherwise in step with GitHub, because feature branches start from `origin/main` and would not include an unpushed change.
- **Hand work over in either direction:** a feature can be started by an agent and finished by hand in its worktree, or started by hand and handed to an agent ("continue this branch"). Any branch, whoever wrote it, goes through the same checks, review, PR and CI.

Rules that keep this safe:

- An agent works in its own worktree, never in the main folder while the user has uncommitted changes there.
- The factory watches each project's git state. Commits and branches made by hand show up in the UI; uncommitted changes are shown but never touched, stashed or reset by the factory.
- If the user and an agent change the same branch, the factory stops the agent and asks, instead of merging automatically.

## 8. Data model

| Table | Key fields |
|---|---|
| `projects` | id, name, repo, path, kit, kit_version, phase, created_at |
| `features` | id, project_id, slug, title, status, origin (agent, manual), branch, worktree, pr_number, depends_on, attempts |
| `runs` | id, feature_id or kit_id, purpose (spec, build, fix, review, kit), claude_session_id, pid, status, tokens_in, tokens_out, started_at, ended_at |
| `events` | run_id, seq, type, payload |
| `checks` | id, feature_id, run_id, name, command, exit_code, log_path |
| `approvals` | id, feature_id or project_id, gate, decision, comment, at |
| `pipeline_runs` | id, project_id, workflow, sha, status, url (mirror of GitHub Actions) |
| `deployments` | id, project_id, env, sha, status, url, at |
| `settings` | key, value (concurrency, domain, GitHub owner, paths) |
| `cleanup_log` | id, at, kind (run, run log, worktree, session), target, detail, bytes, ok |

## 9. Deployment and gateway integration

### 9.0 Bundled gateway

The repository ships a gateway in `deploy/gateway/`: one Caddy container, a `Caddyfile` that imports one file per site, and `scripts/gateway.sh`. `deploy/install-gateway.sh <domain> [email]` copies it to `$FACTORY_HOME/gateway`, writes its `.env`, creates the first login, starts it and publishes the factory's UI behind that login. Running it again updates the gateway's own files and keeps sites, logins and settings.

- It joins two fixed networks, the edge network of the apps and the network of the factory's UI, so adding a site never recreates the container.
- A site added with `--auth` is refused while no login exists, and the last login cannot be deleted while a site requires one.
- Passwords are hashed by Caddy and reach it on standard input, never on a command line.
- The domain `localhost` works for trying the factory on one machine; Caddy then issues certificates from its own local authority.
- `GATEWAY_DIR` can point at another gateway instead. What the factory needs from one is listed at the top of `apps/host/src/gateway.ts`. Sections 9.1 and 9.2 describe the installation this project was first built on, which uses such a separate gateway with one network per project.
- Verified on spare ports with throwaway containers: install, login, a site added by the factory's own code, 401 without and 200 with the login, an open site, the health-check path. Not verified: a real domain with public certificates, and a fresh machine.

### 9.1 Current server setup

- `gateway-caddy` is the only listener on 80/443. Sites are one file each in `the gateway checkout/sites/`, managed by `scripts/gateway.sh` (`add`, `remove`, `reload`, `validate`, `status`, `test`, `hosts`).
- Each project has its own Docker network that the gateway joins. `gateway.sh add` with a new network edits the gateway's `docker-compose.yml` and recreates the Caddy container.
- Certificates are issued per subdomain over HTTP-01 for `*.example.com`.

### 9.2 How the factory uses it

- The gateway is registered as a **system project**: visible in the UI (sites, upstream health, certificates), and every change the factory makes is committed to the gateway's repository.
- The factory calls `gateway.sh`; it does not edit Caddy files on its own. Missing operations (for example multi-site files, edge network support) are added to `gateway.sh` in the gateway's repository.
- **Implemented as:** `factory-host` calls `gateway.sh add <name>-dev <name>-dev:<port> factory-edge --auth`, then `reload`, then commits the site file in the gateway's repository (local commit, not pushed). The app's web service joins `factory-edge` with the network alias `<name>-dev`, so no fixed container name is needed and a production copy can use another alias (`APP_HOST`).
- **One shared edge network.** To avoid recreating the gateway for every new app, factory apps use a network `factory-edge` that the gateway joins once. Only an app's web container joins `factory-edge`; its database and other services stay on the app's private network. Adding a site then needs only a Caddy reload.
- The factory itself is served at `https://factory.example.com` (plain HTTP redirects to HTTPS) with `import basicauth`. Its container `factory-app` sits on its own `devappfactory-network`, following the existing one-network-per-project convention. It must never be exposed without authentication, because it controls Docker on this server.

### 9.3 Environments

| Env | URL | Deployed from | Auth | Gateway upstream |
|---|---|---|---|---|
| dev | `<name>-dev.example.com` | The project folder or a feature worktree, source mounted | basic auth | `<name>-dev` |
| preview | `<name>-preview.example.com` | `origin/main`, automatically after each merge done through the factory, or on demand | basic auth | `<name>-preview` |
| production | `<name>.example.com` | The commit currently live on preview, promoted by the user | basic auth by default; can be switched off per project | `<name>-prod` |

Production only ever receives a commit that has been running on preview. That is the approval gate: the user looks at preview, then promotes.

Per-feature preview URLs are left out of v1: each new subdomain needs its own certificate, and Let's Encrypt rate limits make many short-lived subdomains risky. A wildcard certificate (DNS challenge) would lift this later.

### 9.4 Deploy procedure

Each environment has its own clone of the GitHub repository in `~/factory/deploy/<name>/<env>/`, separate from the project folder, so a deployment contains exactly what is on GitHub at one commit. `factory-host` runs these steps:

1. Clone on first use, then `git fetch` and check out the target commit (detached).
2. Pick the compose file: `docker-compose.deploy.yml` when the project has one, otherwise `docker-compose.yml`.
3. Validate the resolved compose configuration. A deployment is refused when a service is privileged, uses the host network or PID namespace, adds capabilities or devices, or mounts anything from outside the deploy folder.
4. Write `.env` in the deploy folder (mode 600) with `APP_HOST`, `APP_ENV` and the environment's variables. Compose reads it for substitution; services that need the values as container environment declare `env_file: .env`.
5. `docker compose -p <name>-<env> up -d --build`.
6. Health check: request `runtime.health` on `runtime.port` from inside the gateway container, retrying for up to 90 seconds. This proves the gateway can reach the app.
7. Publish the gateway site if it does not exist yet.

If the health check fails and an earlier commit was live, that commit is checked out and started again, and the deployment is recorded as `failed` with `rolled back`. Without an earlier commit the stack is stopped.

Every deployment is a row in SQLite with its commit, status and log. "Roll back" deploys the commit of the previous successful deployment in that environment. One deployment runs at a time per environment.

### 9.5 Environment variables and secrets

Variables are set per project and environment in the UI. They are stored in SQLite encrypted with AES-256-GCM, using `FACTORY_SECRET_KEY` from the factory's own `.env` file (generated at install, never committed). The API never returns a value after it is saved, only the names. Values are decrypted at deploy time, passed to `factory-host` over the Unix socket, and written only to the `.env` file in the deploy folder, which agents cannot reach.

## 10. CI/CD and workflows

- **CI runs on GitHub Actions** (GitHub-hosted runners): install, lint, test, build. Workflow files come from kit workflow components and live in the repo.
- **CD is done by the factory**, not by Actions: the factory is already on the target server, so it deploys after polling shows CI green on `main`. This avoids giving GitHub a path into the server.
- The UI shows workflows, runs and logs; can edit workflow files (as a feature branch and PR); can re-run a workflow; can hand a failed run to the ci-fixer agent.
- GitHub state is polled every 30 to 60 seconds for active projects. Webhooks are optional later, since the server is publicly reachable through Caddy.
- Registering a self-hosted runner per factory project is a later option if Actions minutes for private repos become a limit.

## 11. Web UI

| Screen | Content |
|---|---|
| Dashboard | Projects with phase and health, running and queued agents, items waiting for approval |
| New project | Name, visibility, idea, kit, component selection |
| Project overview | Phase timeline, feature board by status, deployments, latest CI, git state (branches, manual commits, uncommitted changes) |
| Develop | Path, open in VS Code, web terminal, dev environment controls and logs, check buttons, which folder the dev URL serves |
| AI features | Toggles and per-project editing for rules, skills, subagents, hooks, MCP servers, workflows; kit update notice |
| Spec | Chat with the spec agent beside the live spec document; approve |
| Feature | Spec, live transcript, checks, diff, approve or request changes, PR and CI status |
| Agents | All runs: status, tokens, duration; stop, resume, send message; queue and concurrency setting |
| Pipelines | Workflows, runs, logs, re-run, "fix with agent" |
| Deployments | Environments, deployed SHA, history, deploy, rollback, env vars and secrets |
| Kits | Library browser, editor, AI create/improve, promote from project, versions |
| Cleanup | Agent runs, leftover worktrees and Claude sessions with their size; delete what is no longer needed; log of deletions |
| Gateway | Sites, upstreams, health, certificates (from `gateway.sh`) |
| Settings | GitHub owner, domain, paths, Claude login status, limits |

## 12. Security

- UI behind Caddy basic auth over HTTPS; the app also checks a session. The factory can start agents and deployments on this server, so it must never be reachable without authentication.
- `factory-app` has no Docker socket and no credentials. It reaches the server only through the fixed operations of `factory-host` over a Unix socket.
- `factory-host` validates every request: paths must be under `~/factory` (or `GATEWAY_DIR` for gateway operations), project names must match the naming rule, commands are built from fixed templates.
- Agents run as the server user with the permission policy of section 5.4; that policy limits mistakes but is not a sandbox.
- Agent output is untrusted: PR creation, merges and deploys are performed by `factory-host` code with fixed commands, never by passing agent text to a shell.
- Production deploys and merges to `main` require an explicit user action in v1.
- The web terminal gives a shell as the server user; it is covered by the same authentication and can be disabled in settings.
- Deployed apps: scaffolds set non-root users, no privileged mode and no host mounts, and the deploy step rejects a production `docker-compose.yml` that adds them.

## 13. Milestones

| # | Goal | Done when |
|---|---|---|
| 1 | Skeleton (**done**) | `factory-app` container, `factory-host` service, UI shell at `factory.example.com`, SQLite, create project (GitHub repo, clone, `base` kit applied). Project creation is tested in dry-run only; no real project has been created yet |
| 2 | Runner (**done**, except limit-pause, which is untested, and the UI, which was not checked in a browser) | Start an agent in a project folder from the UI, live transcript, stop, resume, limit-pause handling, permission policy enforced |
| 3 | Develop (**done in part**) | Done: dev environment at `<name>-dev` (start, rebuild, restart, stop, logs), check buttons, git view, AI feature toggles for rules, skills, subagents and workflows, VS Code link. Not done: web terminal, toggles for hooks and MCP servers, per-project editing of a feature, pointing the dev URL at a feature worktree |
| 4 | Feature pipeline (**done**) | Worktree and branch per feature, agent build, checks with an automatic fix loop, diff review, request changes, pull request, CI status mirrored, merge with cleanup, discard, preview on the dev URL. Verified end to end on a real project except the fix loop after a failing check and a pull request with CI checks, which no test exercised |
| 5 | Deploy (**done**) | Preview and production deployments from pinned clones, compose safety validation, health check through the gateway, automatic return to the previous commit on failure, manual rollback, stop, encrypted variables, preview redeployed after each merge, production by promoting preview. Verified on a real project, including a failed health check. Not exercised: a project with its own image build or `docker-compose.deploy.yml`, and production without login |
| 6 | Spec and plan phases (**done**) | Spec and plan conversations with an agent, approval that commits and pushes the documents, plan validation, planned features started in dependency order, phase timeline. Verified on a real project from idea to the second planned feature starting after the first was merged. A run that hit the Claude usage limit ended as `paused_limit` and resumed correctly |
| 7 | Kits in the UI (**done**) | Kits page with browsing, editing, creating, validation and a pending-changes review before commit; agent tasks on the library; drift between a project and the library with promote; kit upgrade as a reviewable feature. Verified through the API on the live library and a real project. Not built: Monaco editor, per-project editing of a component from the project page, toggles for hooks and MCP servers |
| 8 | Pipelines | Workflow management, re-run, ci-fixer agent |
| 9 | Teams (**done**, UI not checked in a browser) | Teams of subagents with rules, skills, commands, hooks and MCP servers, assigned to one or several projects, with update and removal; hooks and MCP servers installed for real, also as per-project switches and in kits; runs led by a chosen subagent; runs limited to the project's own MCP servers. Not built: choosing a lead for feature builds and phases, secrets for MCP servers, drift detection for hooks and MCP servers. |

Milestone 2 carries the most technical risk and should be prototyped first within milestone 1 (a script that drives one headless Claude Code session from `factory-host`).

## 14. Out of scope for v1

- Multiple users, roles, hosted or multi-server operation.
- Managing projects that already exist on the server. They keep their locations and workflows; the gateway is the only existing project integrated.
- Mobile apps and deploy targets other than this server.
- Per-feature preview environments.

## 15. Open questions

1. **Limit reached:** the runner reads `rate_limit_event`, but pausing and resuming at a real limit is untested.
2. **Dev URL per feature:** v1 has one dev URL per project that can be pointed at a worktree. Separate URLs per feature need more certificates or a wildcard certificate.
3. **Browser end-to-end tests:** run in a test container against the dev environment (proposed), or against preview.
4. **Web terminal:** include it in v1, or rely on VS Code and SSH only.
