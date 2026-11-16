#!/usr/bin/env node
// PreToolUse hook for factory-started Claude Code runs.
// Passed to the run with --settings, so hand-started sessions never load it.
// Reads the hook payload on stdin; prints a deny decision or nothing (= no opinion).
import { realpathSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname, basename, sep } from "node:path";

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"]);
const PATH_FIELDS = ["file_path", "notebook_path", "path"];
const SECRET_FILE = /^\.env(\..+)?$/;
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
// The agent must not widen its own permissions: these files decide what it may run,
// and hooks and MCP servers are programs that run outside this guard.
const PROTECTED = [/^\.factory\//, /^\.claude\/settings(\.local)?\.json$/, /^\.claude\/hooks\//, /^\.mcp\.json$/];
const SECRET_IN_COMMAND = /(^|[\s\/'"=<>])\.env(\.(?!example\b)[\w.-]+)?($|[\s'";|&)<>])/;
const BLOCKED_COMMANDS = [/(^|[;&|(\s])sudo\s/, /\bgit\s+push\b/, /\bgh\s/, /\bdocker\s+(?!compose\b)/];

// Resolve symlinks on the deepest existing ancestor, so a link inside the
// workdir cannot point a write somewhere else.
function realish(p) {
	let cur = resolve(p);
	const tail = [];
	while (!existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) break;
		tail.unshift(basename(cur));
		cur = parent;
	}
	return resolve(realpathSync(cur), ...tail);
}

export function decide(payload, workdir) {
	const tool = payload.tool_name;
	const input = payload.tool_input ?? {};
	const root = realish(workdir);

	if (FILE_TOOLS.has(tool)) {
		for (const field of PATH_FIELDS) {
			const value = input[field];
			if (typeof value !== "string" || value === "") continue;
			const target = realish(resolve(payload.cwd ?? root, value));
			if (target !== root && !target.startsWith(root + sep)) {
				return `${tool} outside the run's working directory is not allowed: ${value}`;
			}
			const rel = target.slice(root.length + 1);
			if (WRITE_TOOLS.has(tool) && PROTECTED.some((p) => p.test(rel))) {
				return `${tool} on factory-managed permission files is not allowed: ${value}`;
			}
			if (SECRET_FILE.test(basename(target))) {
				return `${tool} on secret files is not allowed: ${value}`;
			}
		}
	}
	if (tool === "Bash" && typeof input.command === "string") {
		for (const pattern of BLOCKED_COMMANDS) {
			if (pattern.test(input.command)) return `Command not allowed in factory runs: ${input.command}`;
		}
		// Best effort: Bash can still reach a secret file through a glob or a script.
		// The real protection is that secrets are never stored in project folders.
		if (SECRET_IN_COMMAND.test(input.command)) return `Commands that touch secret files are not allowed: ${input.command}`;
	}
	return null;
}

function main() {
	const workdir = process.env.FACTORY_WORKDIR;
	let reason;
	try {
		if (!workdir) throw new Error("FACTORY_WORKDIR is not set");
		const payload = JSON.parse(readFileSync(0, "utf8"));
		reason = decide(payload, workdir);
	} catch (err) {
		// Fail closed: a broken guard must not silently allow everything.
		reason = `factory guard error: ${err.message}`;
	}
	if (reason) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
			}),
		);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) main();
