#!/usr/bin/env node
// SessionStart hook: tells the agent what is true in the project right now (branch, work in
// progress, recent commits). What it prints is added to the session's context.
import { spawnSync } from "node:child_process";

const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const git = (...args) => (spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000 }).stdout ?? "").trim();

try {
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch) {
		const status = git("status", "--porcelain").split("\n").filter(Boolean);
		const ahead = git("rev-list", "--count", "origin/main..HEAD");
		const lines = [`Project state at session start: branch ${branch}${ahead && ahead !== "0" ? `, ${ahead} commit(s) not on origin/main` : ""}.`];
		if (status.length) {
			lines.push(`Uncommitted changes (${status.length} file(s)); they may be someone's work in progress, so do not discard them:`, ...status.slice(0, 20), ...(status.length > 20 ? [`... and ${status.length - 20} more`] : []));
		} else {
			lines.push("The working tree is clean.");
		}
		const log = git("log", "--oneline", "-5");
		if (log) lines.push("Recent commits:", log);
		process.stdout.write(lines.join("\n") + "\n");
	}
} catch {
	// Context is a convenience; never fail a session over it.
}
