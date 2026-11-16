import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decide } from "../hooks/guard.mjs";

const base = mkdtempSync(join(tmpdir(), "guard-"));
const work = join(base, "work");
const other = join(base, "other");
mkdirSync(join(work, "src"), { recursive: true });
mkdirSync(other);
writeFileSync(join(other, "x.txt"), "x");
symlinkSync(other, join(work, "link"));

const call = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: work }, work);

test("allows files inside the workdir", () => {
	assert.equal(call("Write", { file_path: join(work, "src/new.ts") }), null);
	assert.equal(call("Read", { file_path: "src/a.ts" }), null);
	assert.equal(call("Grep", { pattern: "x" }), null);
});

test("denies files outside the workdir", () => {
	assert.match(call("Read", { file_path: join(other, "x.txt") }), /outside/);
	assert.match(call("Edit", { file_path: "../other/x.txt" }), /outside/);
	assert.match(call("Write", { file_path: work + "-evil/x" }), /outside/);
});

test("denies escaping through a symlink", () => {
	assert.match(call("Write", { file_path: join(work, "link/new.txt") }), /outside/);
});

test("denies secret files", () => {
	assert.match(call("Read", { file_path: ".env" }), /secret/);
	assert.match(call("Read", { file_path: "src/.env.production" }), /secret/);
	assert.equal(call("Read", { file_path: "src/env.ts" }), null);
});

test("denies writes to permission files, allows reading them", () => {
	assert.match(call("Write", { file_path: ".factory/project.yml" }), /permission files/);
	assert.match(call("Edit", { file_path: join(work, ".claude/settings.json") }), /permission files/);
	assert.match(call("Write", { file_path: ".claude/hooks/format/run.sh" }), /permission files/);
	assert.match(call("Edit", { file_path: ".mcp.json" }), /permission files/);
	assert.equal(call("Read", { file_path: ".factory/project.yml" }), null);
	assert.equal(call("Write", { file_path: ".claude/rules/new.md" }), null);
});

test("denies blocked commands, allows others", () => {
	assert.match(call("Bash", { command: "git push origin main" }), /not allowed/);
	assert.match(call("Bash", { command: "cd x && sudo rm -rf /" }), /not allowed/);
	assert.match(call("Bash", { command: "docker run -v /:/host alpine" }), /not allowed/);
	assert.match(call("Bash", { command: "gh pr create" }), /not allowed/);
	assert.equal(call("Bash", { command: "docker compose run --rm app pnpm test" }), null);
	assert.equal(call("Bash", { command: "git commit -m 'push button'" }), null);
});

test("denies commands that name secret files", () => {
	assert.match(call("Bash", { command: "cat .env" }), /secret/);
	assert.match(call("Bash", { command: "grep KEY ./config/.env.production | head" }), /secret/);
	assert.match(call("Bash", { command: "cp x >.env" }), /secret/);
	assert.equal(call("Bash", { command: "cp .env.example config.sample" }), null);
	assert.equal(call("Bash", { command: "node --env-file-if-exists=x app.environment.js" }), null);
});

const guard = new URL("../hooks/guard.mjs", import.meta.url).pathname;
const run = (payload, env) =>
	spawnSync("node", [guard], { input: JSON.stringify(payload), env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

test("as a process: prints a deny decision, or nothing", () => {
	const denied = run({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" }, cwd: work }, { FACTORY_WORKDIR: work });
	assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
	const ok = run({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd: work }, { FACTORY_WORKDIR: work });
	assert.equal(ok.stdout, "");
});

test("as a process: fails closed without FACTORY_WORKDIR", () => {
	const res = run({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd: work }, {});
	assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
});
