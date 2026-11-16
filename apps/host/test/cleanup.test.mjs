// What cleanup finds on disk and what it removes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "cleanup-home-"));
const claude = mkdtempSync(join(tmpdir(), "cleanup-claude-"));
process.env.FACTORY_HOME = home;
process.env.CLAUDE_PROJECTS_DIR = claude;
const { storage, deleteRunLog, deleteWorktree, deleteSession } = await import("../dist/cleanup.js");

const RUN = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const prefix = `${home.replace(/[^A-Za-z0-9]/g, "-")}-`;
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

// A run log, a project with one feature worktree, and sessions inside and outside the factory.
mkdirSync(join(home, "runs", RUN), { recursive: true });
writeFileSync(join(home, "runs", RUN, "events.jsonl"), "x".repeat(100));
mkdirSync(join(home, "runs", "not-a-run"));
const main = join(home, "projects", "demo");
mkdirSync(main, { recursive: true });
git(main, "init", "-q", "-b", "main");
writeFileSync(join(main, "a.txt"), "a");
git(main, "add", "-A");
git(main, "commit", "-q", "-m", "init");
const tree = join(home, "worktrees", "demo", "add-footer");
mkdirSync(join(home, "worktrees", "demo"), { recursive: true });
git(main, "worktree", "add", "-q", "-b", "feature/add-footer", tree);
writeFileSync(join(tree, "draft.txt"), "not committed");
const mine = join(claude, `${prefix}projects-demo`);
const other = join(claude, "-home-someone-else");
for (const dir of [mine, other]) {
	mkdirSync(join(dir, SESSION), { recursive: true });
	writeFileSync(join(dir, `${SESSION}.jsonl`), "y".repeat(50));
	writeFileSync(join(dir, SESSION, "subagent.jsonl"), "z".repeat(20));
}
mkdirSync(join(mine, "memory"));

test("lists run logs, worktrees and only the sessions of factory folders", async () => {
	const s = await storage();
	assert.deepEqual(s.runLogs.map((l) => [l.id, l.bytes, l.active]), [[RUN, 100, false]]);
	assert.equal(s.worktrees.length, 1);
	assert.deepEqual([s.worktrees[0].project, s.worktrees[0].slug, s.worktrees[0].branch, s.worktrees[0].uncommitted], ["demo", "add-footer", "feature/add-footer", 1]);
	assert.deepEqual(s.sessions.map((x) => [x.where, x.id, x.bytes]), [["projects-demo", SESSION, 70]]);
});

test("refuses names that could point somewhere else", async () => {
	assert.throws(() => deleteRunLog("../projects"), /invalid/);
	assert.throws(() => deleteRunLog("not-a-run"), /invalid/);
	await assert.rejects(deleteWorktree("demo", "../../projects/demo"), /invalid/);
	await assert.rejects(deleteWorktree("..", "x"), /invalid/);
	assert.throws(() => deleteSession("-home-someone-else", SESSION), /invalid/);
	assert.throws(() => deleteSession(`${prefix}projects-demo/..`, SESSION), /invalid/);
	assert.throws(() => deleteSession(`${prefix}projects-demo`, "memory"), /invalid/);
});

test("deletes a run log and reports what it freed", () => {
	assert.deepEqual(deleteRunLog(RUN), { ok: true, bytes: 100, existed: true });
	assert.ok(!existsSync(join(home, "runs", RUN)));
	assert.equal(deleteRunLog(RUN).existed, false);
	assert.ok(existsSync(join(home, "runs", "not-a-run")));
});

test("deletes a worktree, keeps its branch and leaves the project alone", async () => {
	const res = await deleteWorktree("demo", "add-footer");
	assert.ok(res.bytes > 0);
	assert.ok(!existsSync(tree));
	assert.ok(!existsSync(join(home, "worktrees", "demo"))); // the empty project folder goes too
	assert.match(git(main, "branch", "--list", "feature/add-footer").stdout, /feature\/add-footer/);
	assert.doesNotMatch(git(main, "worktree", "list").stdout, /add-footer/);
	assert.ok(existsSync(join(main, "a.txt")));
	await assert.rejects(deleteWorktree("demo", "add-footer"), /not found/);
});

test("deletes a session with its subagent transcripts, and nothing next to it", () => {
	assert.equal(deleteSession(`${prefix}projects-demo`, SESSION).bytes, 70);
	assert.ok(!existsSync(join(mine, `${SESSION}.jsonl`)) && !existsSync(join(mine, SESSION)));
	assert.ok(existsSync(join(mine, "memory")));
	assert.ok(existsSync(join(other, `${SESSION}.jsonl`)));
});
