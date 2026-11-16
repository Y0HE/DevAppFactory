// Project operations on the server: create (GitHub repo + local clone + kit) and git state.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { config, PROJECT_NAME } from "./config.js";
import { run } from "./exec.js";
import { applyKit, loadKit, pendingExecutables } from "./kits.js";
import { siteExists } from "./gateway.js";
import { installTeams, loadTeamsForProject, type Team } from "./teams.js";

export interface Step {
	step: string;
	ok: boolean;
	detail?: string;
}

export interface CreateRequest {
	name: string;
	kit: string;
	idea?: string;
	visibility?: "private" | "public";
	/** Teams the project starts with; their components are part of the first commit. */
	teams?: string[];
	/** Validate and render the kit into a temp folder; create nothing on GitHub or in projects/. */
	dryRun?: boolean;
}

export interface CreateResult {
	ok: boolean;
	steps: Step[];
	project?: { name: string; path: string; repo: string; url: string; kit: string; kitVersion: number; teams: string[] };
	files?: string[];
}

let cachedOwner = config.ghOwner;
export async function ghOwner(): Promise<string> {
	if (!cachedOwner) {
		const res = await run("gh", ["api", "user", "-q", ".login"]);
		if (!res.ok) throw new Error(`cannot detect GitHub user: ${res.stderr}`);
		cachedOwner = res.stdout;
	}
	return cachedOwner;
}

export function projectPath(name: string): string {
	if (!PROJECT_NAME.test(name)) throw new Error(`invalid project name: ${name}`);
	return join(config.projectsDir, name);
}

export async function createProject(req: CreateRequest): Promise<CreateResult> {
	const steps: Step[] = [];
	const fail = (step: string, detail: string): CreateResult => (steps.push({ step, ok: false, detail }), { ok: false, steps });
	const pass = (step: string, detail?: string) => steps.push({ step, ok: true, detail });

	if (!PROJECT_NAME.test(req.name ?? "")) return fail("validate", "Name must be lowercase letters, digits and dashes (max 40), starting and ending with a letter or digit.");
	let kit;
	try {
		kit = loadKit(req.kit);
	} catch (err) {
		return fail("validate", String((err as Error).message));
	}
	const pending = await pendingExecutables(kit.components).catch((err) => [String((err as Error).message)]);
	if (pending.length) return fail("validate", `Commit these on the Kits page first, because they run programs on the server: ${pending.join(", ")}`);
	let teams: Team[];
	try {
		teams = await loadTeamsForProject(req.teams);
	} catch (err) {
		return fail("validate", String((err as Error).message));
	}
	const teamNames = teams.map((t) => t.id);
	const visibility = req.visibility === "public" ? "public" : "private";
	const dir = projectPath(req.name);
	if (existsSync(dir)) return fail("validate", `${dir} already exists`);
	// The project's production, preview and dev sites are named after it.
	const taken = [req.name, `${req.name}-preview`, `${req.name}-dev`].find(siteExists);
	if (taken) return fail("validate", `The gateway already serves a site named "${taken}", so this name cannot be used.`);

	const owner = await ghOwner();
	const repo = `${owner}/${req.name}`;
	if ((await run("gh", ["repo", "view", repo, "--json", "name"])).ok) return fail("validate", `GitHub repo ${repo} already exists`);
	pass("validate", `${repo} (${visibility}), kit ${kit.name}@${kit.version}${teamNames.length ? `, teams ${teamNames.join(", ")}` : ""}`);

	if (req.dryRun) {
		const tmp = mkdtempSync(join(tmpdir(), "factory-dryrun-"));
		try {
			applyKit(tmp, kit, { name: req.name, idea: req.idea ?? "" });
			installTeams(tmp, teams);
			const files = projectFiles(tmp);
			pass("kit", `${files.length} files would be written`);
			return { ok: true, steps, files };
		} catch (err) {
			return fail("kit", String((err as Error).message));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	mkdirSync(dir, { recursive: true });
	let files: string[] = [];
	try {
		const git = (...args: string[]) => run("git", args, { cwd: dir });

		const init = await git("init", "-q", "-b", "main");
		if (!init.ok) throw step("clone", init.stderr);
		pass("clone", dir);

		applyKit(dir, kit, { name: req.name, idea: req.idea ?? "" });
		installTeams(dir, teams);
		files = projectFiles(dir);
		pass("kit", `${files.length} files written${teamNames.length ? `, with ${teamNames.length === 1 ? "team" : "teams"} ${teamNames.join(", ")}` : ""}`);

		await git("add", "-A");
		const commit = await git("commit", "-q", "-m", `Initial commit from kit ${kit.name}@${kit.version}${teamNames.length ? ` with ${teamNames.length === 1 ? "team" : "teams"} ${teamNames.join(", ")}` : ""}`);
		if (!commit.ok) throw step("commit", commit.stderr || commit.stdout);
		pass("commit");

		const create = await run("gh", ["repo", "create", repo, `--${visibility}`, "--source=.", "--remote=origin", "--push"], { cwd: dir, timeoutMs: 120_000 });
		if (!create.ok) throw step("github", create.stderr);
		pass("github", `https://github.com/${repo}`);
	} catch (err) {
		// Nothing was published if we got here before the repo existed, so the folder can go.
		const e = err as StepError;
		const repoExists = (await run("gh", ["repo", "view", repo, "--json", "name"])).ok;
		if (!repoExists) rmSync(dir, { recursive: true, force: true });
		return fail(e.stepName ?? "error", `${e.message}${repoExists ? " (GitHub repo exists; local folder kept)" : " (local folder removed)"}`);
	}

	return {
		ok: true,
		steps,
		files,
		project: { name: req.name, path: dir, repo, url: `https://github.com/${repo}`, kit: kit.name, kitVersion: kit.version, teams: teamNames },
	};
}

/** Every file in a project folder, relative to it, without git's own. */
function projectFiles(dir: string): string[] {
	const walk = (d: string): string[] => readdirSync(d).flatMap((e) => (e === ".git" && d === dir ? [] : statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));
	return walk(dir).map((f) => relative(dir, f)).sort();
}

interface StepError extends Error {
	stepName?: string;
}
function step(name: string, message: string): StepError {
	const err: StepError = new Error(message);
	err.stepName = name;
	return err;
}

export interface GitState {
	exists: boolean;
	branch?: string;
	uncommitted?: number;
	lastCommit?: { sha: string; subject: string; at: string };
	ahead?: number;
	behind?: number;
}

/** Working tree changes, branches and recent commits, for the project's git view. */
export async function gitDetail(name: string) {
	const dir = projectPath(name);
	if (!existsSync(join(dir, ".git"))) return { exists: false };
	const git = (...args: string[]) => run("git", args, { cwd: dir });
	const [state, status, branches, log] = await Promise.all([
		gitState(name),
		git("status", "--porcelain"),
		git("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(objectname:short)%09%(committerdate:iso-strict)%09%(subject)", "refs/heads"),
		git("log", "-15", "--format=%h%x09%an%x09%cI%x09%s"),
	]);
	const rows = (out: string) => (out ? out.split("\n").map((line) => line.split("\t")) : []);
	return {
		...state,
		changes: status.stdout ? status.stdout.split("\n").slice(0, 100).map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3) })) : [],
		branches: rows(branches.stdout).map(([name, sha, at, subject]) => ({ name, sha, at, subject })),
		commits: rows(log.stdout).map(([sha, author, at, subject]) => ({ sha, author, at, subject })),
	};
}

export async function gitState(name: string): Promise<GitState> {
	const dir = projectPath(name);
	if (!existsSync(join(dir, ".git"))) return { exists: false };
	const git = (...args: string[]) => run("git", args, { cwd: dir });
	const [branch, status, log, counts] = await Promise.all([
		git("rev-parse", "--abbrev-ref", "HEAD"),
		git("status", "--porcelain"),
		git("log", "-1", "--format=%h%x09%s%x09%cI"),
		git("rev-list", "--left-right", "--count", "HEAD...@{upstream}"),
	]);
	const [sha, subject, at] = log.stdout.split("\t");
	const [ahead, behind] = counts.ok ? counts.stdout.split(/\s+/).map(Number) : [undefined, undefined];
	return {
		exists: true,
		branch: branch.stdout,
		uncommitted: status.stdout ? status.stdout.split("\n").length : 0,
		lastCommit: log.ok && sha ? { sha, subject, at } : undefined,
		ahead,
		behind,
	};
}
