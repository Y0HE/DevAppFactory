#!/usr/bin/env node
// Stop hook: runs the project's checks when the agent wants to finish. When one fails, the stop is
// blocked and the failing output goes back to the agent, so it cannot end a turn on red.
// Exit 0 lets the agent stop; exit 2 blocks the stop and sends stderr to the agent.
// Anything unexpected lets the agent stop: a broken hook must never trap a session.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK_TIMEOUT_MS = 300_000;
const MAX_OUTPUT = 3000;
/** After this many blocked stops in a row the agent may stop anyway, and the failure is left to the user. */
const MAX_BLOCKS = 3;

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Reads `checks` and `allowed_commands` from the text of `.factory/project.yml`, without a YAML library. */
export function readProject(text) {
	const checks = {};
	const allowed = [];
	let section = null;
	let last = null;
	for (const line of text.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (top) {
			section = top[1];
			last = null;
			if (section === "allowed_commands" && top[2].startsWith("[")) {
				for (const item of top[2].replace(/^\[|\]$/g, "").split(",")) if (item.trim()) allowed.push(unquote(item));
			}
			continue;
		}
		if (section === "checks") {
			const entry = line.match(/^ {2}([\w.-]+):\s*(.*)$/);
			if (entry) {
				last = entry[1];
				checks[last] = unquote(entry[2].replace(/^[>|][+-]?$/, ""));
			} else if (last && /^ {3,}\S/.test(line)) {
				// A long command that YAML wrapped onto the next line.
				checks[last] = `${checks[last]} ${line.trim()}`.trim();
			}
		} else if (section === "allowed_commands") {
			const item = line.match(/^\s*-\s+(.*)$/);
			if (item) allowed.push(unquote(item[1]));
		}
	}
	return { checks, allowed };
}

const git = (dir, ...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 20_000 }).stdout ?? "";

/** Identifies the exact state of the code, so unchanged code is not checked twice. */
function fingerprint(dir) {
	return createHash("sha1").update(git(dir, "rev-parse", "HEAD")).update(git(dir, "status", "--porcelain")).update(git(dir, "diff", "HEAD")).digest("hex");
}

/** True when the folder holds nothing that is not already on the remote's main branch. */
function nothingNew(dir) {
	const head = git(dir, "rev-parse", "HEAD").trim();
	return head !== "" && head === git(dir, "rev-parse", "origin/main").trim() && git(dir, "status", "--porcelain").trim() === "";
}

export function runChecks(dir, { checks, allowed }) {
	const failures = [];
	for (const [name, command] of Object.entries(checks)) {
		// Same rule as the factory: no shell, and the command must start with an allowed one.
		if (!command || !allowed.some((a) => command === a || command.startsWith(`${a} `))) continue;
		const [file, ...args] = command.trim().split(/\s+/);
		const res = spawnSync(file, args, { cwd: dir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: 20_000_000 });
		if (res.error) continue; // could not start or timed out: not the agent's failure to fix
		if (res.status !== 0) failures.push({ name, command, output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(-MAX_OUTPUT) });
	}
	return failures;
}

function main() {
	let payload = {};
	try {
		payload = JSON.parse(readFileSync(0, "utf8"));
	} catch {}
	const dir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
	const file = join(dir, ".factory", "project.yml");
	if (!existsSync(file)) return 0;
	const project = readProject(readFileSync(file, "utf8"));
	if (!Object.keys(project.checks).length || nothingNew(dir)) return 0;

	const stateFile = join(tmpdir(), `factory-checks-${createHash("sha1").update(realpathSync(dir)).digest("hex").slice(0, 16)}.json`);
	let state = {};
	try {
		state = JSON.parse(readFileSync(stateFile, "utf8"));
	} catch {}
	const save = (next) => {
		try {
			writeFileSync(stateFile, JSON.stringify(next));
		} catch {}
	};

	const before = fingerprint(dir);
	if (state.passed === before) return 0;

	const failures = runChecks(dir, project);
	if (!failures.length) {
		save({ passed: fingerprint(dir), blocks: 0 });
		return 0;
	}
	const blocks = (state.blocks ?? 0) + 1;
	if (blocks > MAX_BLOCKS) {
		save({ blocks: 0 });
		return 0;
	}
	save({ blocks });
	process.stderr.write(
		[
			`The project's checks do not pass yet (attempt ${blocks} of ${MAX_BLOCKS}), so the work is not finished.`,
			...failures.map((f) => `\n## ${f.name}: ${f.command}\n${f.output}`),
			"\nFind the cause and fix the code. Do not weaken, skip or delete a test to get past this. If a check cannot pass for a reason outside your task, say so plainly in your final message.",
		].join("\n"),
	);
	return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
	let code = 0;
	try {
		code = main();
	} catch {}
	process.exit(code);
}
