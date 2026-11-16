// The seed kit library shipped in kits/: it must validate, and its hook scripts must behave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const seed = fileURLToPath(new URL("../../../kits", import.meta.url));
const hooks = join(seed, "components", "hooks");

// The library code reads its location from FACTORY_HOME when it is first imported.
const home = mkdtempSync(join(tmpdir(), "kits-"));
cpSync(seed, join(home, "kits"), { recursive: true });
process.env.FACTORY_HOME = home;
const { validate, tree, seedStatus, pullSeed } = await import("../dist/kitlib.js");
const { loadKit, applyKit } = await import("../dist/kits.js");
const { listTeams, installTeams, loadTeam, loadTeamsForProject } = await import("../dist/teams.js");

test("the seed library has no validation errors", () => {
	assert.deepEqual(validate(), []);
});

test("every component is used by a kit or a team, or is meant to be switched on alone", async () => {
	const t = await tree();
	const used = new Set();
	for (const team of listTeams().teams) for (const [kind, ids] of Object.entries(team.components)) for (const id of ids) used.add(`${kind}/${id}`);
	for (const kit of t.kits) for (const [kind, ids] of Object.entries(loadKit(kit.id).components)) for (const id of ids) used.add(`${kind}/${id}`);
	const standalone = new Set(["rules/coding-style", "rules/typescript-style", "skills/database-migrations", "workflows/ci-checks"]);
	const unused = ["agents", "rules", "skills", "commands", "hooks", "mcp", "workflows"].flatMap((kind) => t.components[kind].map((c) => `${kind}/${c.id}`)).filter((key) => !used.has(key) && !standalone.has(key));
	assert.deepEqual(unused, []);
});

test("commands and subagents only mention subagents and skills that exist", async () => {
	const t = await tree();
	const { readFileSync } = await import("node:fs");
	const known = new Set([...t.components.agents, ...t.components.skills].map((c) => c.id));
	for (const item of [...t.components.commands, ...t.components.agents]) {
		const text = readFileSync(join(home, "kits", item.path), "utf8");
		for (const m of text.matchAll(/`([a-z][a-z-]+)` (subagent|skill)/g)) assert.ok(known.has(m[1]), `${item.path} mentions unknown ${m[2]} ${m[1]}`);
	}
});

test("the standard kit applies to an empty folder with its hooks and commands", () => {
	const dir = mkdtempSync(join(tmpdir(), "apply-"));
	const files = applyKit(dir, loadKit("standard"), { name: "demo", idea: "A demo." });
	for (const f of [".claude/agents/implementer.md", ".claude/rules/evidence-first.md", ".claude/skills/systematic-debugging/SKILL.md", ".claude/commands/validate.md", ".factory/project.yml"]) assert.ok(files.includes(f), f);
});

test("teams chosen at creation are installed and recorded with the kit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "teams-"));
	applyKit(dir, loadKit("base"), { name: "demo", idea: "" });
	installTeams(dir, [loadTeam("delivery"), loadTeam("frontend")]);
	const { parse } = await import("yaml");
	const meta = parse(readFileSync(join(dir, ".factory", "project.yml"), "utf8"));
	assert.deepEqual(Object.keys(meta.teams), ["delivery", "frontend"]);
	assert.equal(meta.teams.delivery.version, loadTeam("delivery").version);
	assert.equal(meta.teams.delivery.lead, "implementer");
	assert.deepEqual(meta.teams.frontend.components.agents, ["ui-reviewer"]);
	for (const f of [".claude/agents/implementer.md", ".claude/agents/ui-reviewer.md", ".claude/skills/frontend-design/SKILL.md", ".claude/commands/validate.md", ".claude/hooks/session-context/run.mjs"]) assert.ok(existsSync(join(dir, f)), f);
	// The hook that came with the team is wired into the project's settings, next to the kit's permissions.
	const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
	assert.ok(settings.hooks.SessionStart.length === 1 && settings.permissions.allow.length > 0);
});

test("unknown or malformed team choices are refused before anything is created", async () => {
	await assert.rejects(loadTeamsForProject(["no-such-team"]), /team not found/);
	await assert.rejects(loadTeamsForProject("delivery"), /list of team names/);
	assert.deepEqual(await loadTeamsForProject(undefined), []);
});

const { decide } = await import(join(hooks, "protect-secrets", "run.mjs"));
const bash = (command) => decide({ tool_name: "Bash", tool_input: { command } });

test("protect-secrets refuses credential files", () => {
	assert.match(decide({ tool_name: "Read", tool_input: { file_path: "/p/.env" } }), /credential/);
	assert.match(decide({ tool_name: "Write", tool_input: { file_path: "config/.env.production" } }), /credential/);
	assert.match(decide({ tool_name: "Read", tool_input: { file_path: "/srv/u/.ssh/id_ed25519" } }), /credential/);
	assert.match(decide({ tool_name: "Read", tool_input: { file_path: "certs/server.pem" } }), /credential/);
	assert.match(decide({ tool_name: "Glob", tool_input: { pattern: ".env" } }), /credential/);
	assert.match(bash("cat .env"), /credential/);
	assert.match(bash("cp .env.local /tmp/x"), /credential/);
	assert.match(bash("cat ~/.ssh/id_rsa"), /credential/);
});

test("protect-secrets allows ordinary files and env templates", () => {
	assert.equal(decide({ tool_name: "Read", tool_input: { file_path: "src/env.ts" } }), null);
	assert.equal(decide({ tool_name: "Read", tool_input: { file_path: ".env.example" } }), null);
	assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: "src/keyboard.ts" } }), null);
	assert.equal(decide({ tool_name: "Grep", tool_input: { pattern: ".env", path: "src" } }), null);
	assert.equal(bash("cat .env.example"), null);
	assert.equal(bash("docker compose run --rm app npm test"), null);
	assert.equal(bash("node -e 'console.log(process.env.NODE_ENV)'"), null);
	assert.equal(bash("docker compose run --rm -e NODE_ENV=test app npm run build"), null);
});

test("protect-secrets refuses environment dumps and wide deletes", () => {
	assert.match(bash("printenv"), /environment/);
	assert.match(bash("env | grep KEY"), /environment/);
	assert.match(bash("cat /proc/self/environ"), /environment/);
	assert.match(bash("rm -rf /"), /rm -rf/);
	assert.match(bash("cd x && rm -fr ~"), /rm -rf/);
	assert.match(bash("rm -r -f ."), /rm -rf/);
	assert.match(bash("rm -rf *"), /rm -rf/);
	assert.equal(bash("rm -rf node_modules dist"), null);
	assert.equal(bash("rm -f notes.txt"), null);
	assert.equal(bash("env NODE_ENV=test node x.js"), null);
});

const { readProject } = await import(join(hooks, "checks-before-stop", "run.mjs"));

test("checks-before-stop reads checks and allowed commands from project.yml", async () => {
	const { stringify } = await import("yaml");
	const long = "docker compose run --rm app pnpm install --frozen-lockfile --prefer-offline --reporter append-only";
	const meta = { name: "demo", checks: { compose: "docker compose config -q", install: long, "type-check": "make types" }, runtime: { port: 80 }, allowed_commands: ["docker compose", "make", "git"] };
	assert.deepEqual(readProject(stringify(meta)), { checks: meta.checks, allowed: meta.allowed_commands });
	assert.deepEqual(readProject('checks:\n  a: "make a"\nallowed_commands: ["docker compose", make]\n'), { checks: { a: "make a" }, allowed: ["docker compose", "make"] });
	assert.deepEqual(readProject("name: x\nchecks: {}\n"), { checks: {}, allowed: [] });
});

test("checks-before-stop blocks a stop on a failing check, then lets a passing one through", () => {
	const dir = mkdtempSync(join(tmpdir(), "stop-"));
	const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
	git("init", "-q", "-b", "main");
	mkdirSync(join(dir, ".factory"));
	writeFileSync(join(dir, ".factory", "project.yml"), "checks:\n  marker: git ls-files --error-unmatch ok.txt\n  skipped: sh -c false\nallowed_commands:\n  - git\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	const stop = () => spawnSync("node", [join(hooks, "checks-before-stop", "run.mjs")], { input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

	const red = stop();
	assert.equal(red.status, 2);
	assert.match(red.stderr, /marker/);
	assert.doesNotMatch(red.stderr, /skipped/); // not an allowed command, so it never runs

	writeFileSync(join(dir, "ok.txt"), "ok");
	git("add", "ok.txt");
	assert.equal(stop().status, 0);
});

test("session-context prints the branch and uncommitted files", () => {
	const dir = mkdtempSync(join(tmpdir(), "ctx-"));
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "a");
	const out = spawnSync("node", [join(hooks, "session-context", "run.mjs")], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
	assert.equal(out.status, 0);
	assert.match(out.stdout, /a\.txt/);
});

test("the library reports what the seed has that it lacks, and pulls only what is chosen", () => {
	const lib = join(home, "kits");
	assert.deepEqual(seedStatus().files, []);
	rmSync(join(lib, "components", "skills", "spike"), { recursive: true });
	writeFileSync(join(lib, "components", "rules", "docker-first", "rule.md"), "# Edited here\n");
	writeFileSync(join(lib, "components", "rules", "docker-first", "mine.md"), "only in the library\n");
	assert.deepEqual(seedStatus().files, [
		{ path: "components/rules/docker-first/rule.md", state: "differs" },
		{ path: "components/skills/spike/SKILL.md", state: "new" },
	]);

	assert.throws(() => pullSeed(["../../etc/passwd"]), /not a seed file/);
	assert.throws(() => pullSeed(["components/rules/testing-first/rule.md"]), /not a seed file/); // identical, so nothing to pull
	assert.throws(() => pullSeed([]), /choose/);

	const after = pullSeed(["components/skills/spike/SKILL.md"]);
	assert.equal(after.copied, 1);
	assert.ok(existsSync(join(lib, "components", "skills", "spike", "SKILL.md")));
	assert.equal(readFileSync(join(lib, "components", "rules", "docker-first", "rule.md"), "utf8"), "# Edited here\n"); // not chosen, so kept
	assert.deepEqual(after.files, [{ path: "components/rules/docker-first/rule.md", state: "differs" }]);

	pullSeed(["components/rules/docker-first/rule.md"]);
	assert.deepEqual(seedStatus().files, []);
	assert.ok(existsSync(join(lib, "components", "rules", "docker-first", "mine.md"))); // never deleted
});
