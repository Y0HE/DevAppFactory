#!/usr/bin/env node
// PreToolUse hook: keeps the agent away from credentials and from deleting whole folders.
// Factory-started runs already have the factory guard; this gives sessions started by hand
// in the project the same protection. Prints a deny decision, or nothing (= no opinion).
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "Grep", "Glob"]);
// Fields that name files. A Grep `pattern` is text to search for, not a file, so it is left out there.
const PATH_FIELDS = { Grep: ["path", "glob"], Glob: ["path", "pattern"] };
const DEFAULT_FIELDS = ["file_path", "notebook_path", "path"];
// Templates that are meant to be committed and read.
const TEMPLATE = /^\.env\.(example|sample|template|dist)$/;
const ENV_FILE = /^\.env(\..+)?$/;
const SECRET_PATH = /(^|\/)(id_rsa|id_ed25519|id_ecdsa|\.netrc|\.npmrc|\.pgpass|credentials\.json)$|\.(pem|key|p12|pfx)$|(^|\/)\.ssh\/|(^|\/)\.aws\/credentials$|(^|\/)\.docker\/config\.json$/i;

// The same things, as they appear inside a shell command.
const ENV_IN_COMMAND = /(^|[\s\/'"=<>])\.env(\.(?!(example|sample|template|dist)\b)[\w.-]+)?($|[\s'";|&)<>])/;
const SECRET_IN_COMMAND = /\b(id_rsa|id_ed25519|id_ecdsa)\b|\.(pem|p12|pfx)\b|(^|[\s\/'"=])\.(netrc|pgpass)\b|\.ssh\/|\.aws\/credentials|credentials\.json/i;
const ENV_DUMP = /(^|[;&|(]\s*|\s)(printenv|env)\s*($|[;&|)>])|\/proc\/[^\s\/]+\/environ|(^|[;&|(]\s*)export\s+-p\b/;
// rm with both -r and -f (in any spelling) aimed at a root, a home, the current folder or a bare wildcard.
const RM = /(^|[;&|(]\s*|\s)rm\s+((?:-[a-zA-Z]+\s+|--[a-z-]+\s+)+)(.*)$/;
const WIDE_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*|\$\{HOME\}|\.|\.\/|\.\.|\.\.\/|\*|\.\/\*|\.git|\.\/\.git)$/;

function secretPath(value) {
	const name = basename(value);
	if (TEMPLATE.test(name)) return false;
	return ENV_FILE.test(name) || SECRET_PATH.test(value);
}

function wideDelete(command) {
	for (const part of command.split(/&&|\|\||[;|\n]/)) {
		const m = part.match(RM);
		if (!m) continue;
		const flags = m[2];
		const recursive = /-[a-zA-Z]*[rR]|--recursive/.test(flags);
		const force = /-[a-zA-Z]*f|--force/.test(flags);
		if (!recursive || !force) continue;
		const targets = m[3].trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
		if (targets.some((t) => WIDE_TARGET.test(t))) return true;
	}
	return false;
}

/** The reason a tool call is refused, or null when it may go ahead. */
export function decide(payload) {
	const tool = payload?.tool_name;
	const input = payload?.tool_input ?? {};
	if (FILE_TOOLS.has(tool)) {
		for (const field of PATH_FIELDS[tool] ?? DEFAULT_FIELDS) {
			const value = input[field];
			if (typeof value === "string" && value && secretPath(value)) return `${tool} on credential files is not allowed: ${value}`;
		}
	}
	if (tool === "Bash" && typeof input.command === "string") {
		const command = input.command;
		if (ENV_IN_COMMAND.test(command) || SECRET_IN_COMMAND.test(command)) return "Commands that touch credential files are not allowed. If a secret is needed, stop and ask the user.";
		if (ENV_DUMP.test(command)) return "Printing the whole process environment is not allowed, because it can contain secrets. Read the one variable you need by name.";
		if (wideDelete(command)) return "Deleting a whole folder tree with rm -rf is not allowed here. Delete the specific files or folders by name.";
	}
	return null;
}

function main() {
	let reason = null;
	try {
		reason = decide(JSON.parse(readFileSync(0, "utf8")));
	} catch {
		// Fail open: this hook also runs in sessions started by hand, and a bug here must not block them.
		// Factory runs are covered by the factory's own guard, which fails closed.
	}
	if (reason) {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) main();
