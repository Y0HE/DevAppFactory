// What the factory leaves on disk, and removing it: run logs, feature worktrees and Claude Code
// sessions. This service only looks at the disk; whether something is still needed is decided
// by factory-app, which knows the runs and features.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, PROJECT_NAME } from "./config.js";
import { run } from "./exec.js";
import * as runs from "./runs.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const FOLDER = /^[A-Za-z0-9-]{1,200}$/;

const runsDir = () => join(config.home, "runs");
/** Where Claude Code keeps its sessions: one folder per working directory, named after its path. */
const claudeProjects = () => process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
/** Session folders of working directories inside the factory home start with this. */
const sessionPrefix = () => `${config.home.replace(/[^A-Za-z0-9]/g, "-")}-`;

const dirs = (path: string) => (existsSync(path) ? readdirSync(path).filter((e) => statSync(join(path, e)).isDirectory()) : []);

/** Bytes used by a file or a folder with everything in it. */
function size(path: string): number {
	const st = statSync(path);
	if (!st.isDirectory()) return st.size;
	let total = 0;
	for (const entry of readdirSync(path)) {
		try {
			total += size(join(path, entry));
		} catch {} // vanished meanwhile, or a dangling link
	}
	return total;
}

const modified = (path: string) => statSync(path).mtime.toISOString();

export async function storage() {
	const runLogs = dirs(runsDir())
		.filter((id) => UUID.test(id))
		.map((id) => ({ id, bytes: size(join(runsDir(), id)), modified: modified(join(runsDir(), id)), active: runs.active(id) }));

	const worktrees = [];
	for (const project of dirs(config.worktreesDir).filter((p) => PROJECT_NAME.test(p))) {
		for (const slug of dirs(join(config.worktreesDir, project)).filter((s) => SLUG.test(s))) {
			const dir = join(config.worktreesDir, project, slug);
			const [branch, dirty] = await Promise.all([run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }), run("git", ["status", "--porcelain"], { cwd: dir })]);
			worktrees.push({ project, slug, bytes: size(dir), modified: modified(dir), branch: branch.ok ? branch.stdout : null, uncommitted: dirty.ok && dirty.stdout ? dirty.stdout.split("\n").length : 0 });
		}
	}

	const sessions = [];
	const prefix = sessionPrefix();
	for (const folder of dirs(claudeProjects()).filter((f) => FOLDER.test(f) && f.startsWith(prefix))) {
		const base = join(claudeProjects(), folder);
		for (const file of readdirSync(base).filter((f) => f.endsWith(".jsonl") && UUID.test(f.slice(0, -6)))) {
			const id = file.slice(0, -6);
			const extra = join(base, id); // subagent transcripts of the same session, when there are any
			sessions.push({ folder, where: folder.slice(prefix.length), id, bytes: size(join(base, file)) + (existsSync(extra) ? size(extra) : 0), modified: modified(join(base, file)) });
		}
	}
	return { runLogs, worktrees, sessions };
}

/** Deletes the event log of a finished run. */
export function deleteRunLog(id: string) {
	if (!UUID.test(id ?? "")) throw new Error("invalid run id");
	if (runs.active(id)) throw new Error("that run is still going");
	const dir = join(runsDir(), id);
	if (!existsSync(dir)) return { ok: true, bytes: 0, existed: false };
	const bytes = size(dir);
	rmSync(dir, { recursive: true, force: true });
	return { ok: true, bytes, existed: true };
}

/** Removes a feature's worktree folder. The local branch is kept, so no commit is lost. */
export async function deleteWorktree(project: string, slug: string) {
	if (!PROJECT_NAME.test(project ?? "") || !SLUG.test(slug ?? "")) throw new Error("invalid worktree");
	const dir = join(config.worktreesDir, project, slug);
	if (!existsSync(dir)) throw new Error("worktree not found");
	const bytes = size(dir);
	const main = join(config.projectsDir, project);
	if (existsSync(main)) await run("git", ["worktree", "remove", "--force", dir], { cwd: main });
	rmSync(dir, { recursive: true, force: true }); // when git did not know it, or could not remove it
	if (existsSync(main)) await run("git", ["worktree", "prune"], { cwd: main });
	const left = join(config.worktreesDir, project);
	if (existsSync(left) && readdirSync(left).length === 0) rmSync(left, { recursive: true, force: true });
	return { ok: true, bytes };
}

/** Deletes one Claude Code session of a factory folder. A run that used it can no longer be resumed. */
export function deleteSession(folder: string, id: string) {
	if (!FOLDER.test(folder ?? "") || !folder.startsWith(sessionPrefix()) || !UUID.test(id ?? "")) throw new Error("invalid session");
	const base = join(claudeProjects(), folder);
	const file = join(base, `${id}.jsonl`);
	if (!existsSync(file)) throw new Error("session not found");
	const extra = join(base, id);
	const bytes = size(file) + (existsSync(extra) ? size(extra) : 0);
	rmSync(file, { force: true });
	rmSync(extra, { recursive: true, force: true });
	return { ok: true, bytes };
}
