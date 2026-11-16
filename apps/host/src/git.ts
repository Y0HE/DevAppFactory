import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.js";

/**
 * Commits exactly the given paths and pushes when that is a plain fast-forward of the
 * branch's upstream. Anything else in the folder, staged or not, is left alone.
 */
export async function commitAndSync(dir: string, paths: string[], message: string): Promise<{ committed: boolean; pushed: boolean }> {
	const git = (...args: string[]) => run("git", args, { cwd: dir, timeoutMs: 120_000 });
	// A path that neither exists nor is tracked would make git refuse the whole command.
	const known: string[] = [];
	for (const path of new Set(paths)) {
		if (existsSync(join(dir, path)) || (await git("ls-files", "--", path)).stdout) known.push(path);
	}
	if (!known.length) return { committed: false, pushed: false };
	paths = known;
	await git("add", "-A", "--", ...paths);
	const committed = (await git("commit", "-q", "-m", message, "--", ...paths)).ok;
	let pushed = false;
	if (committed && (await git("fetch", "--quiet", "origin")).ok) {
		const behind = Number((await git("rev-list", "--count", "HEAD..@{upstream}")).stdout || 1);
		if (behind === 0) pushed = (await git("push", "--quiet", "origin", "HEAD")).ok;
	}
	return { committed, pushed };
}
