// Feature pipeline operations on the server: worktree, diff, checks, pull request, merge, discard.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { devAction, devStatus, listChecks, runCheck } from "./devenv.js";
import { run } from "./exec.js";
import { projectPath } from "./projects.js";

const SLUG = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;
const MAX_DIFF = 400_000;

function paths(project: string, slug: string) {
	if (!SLUG.test(slug)) throw new Error(`invalid feature slug: ${slug}`);
	const main = projectPath(project);
	return { main, dir: join(config.worktreesDir, project, slug), branch: `feature/${slug}` };
}

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, timeoutMs: 120_000 });
const gh = (cwd: string, ...args: string[]) => run("gh", args, { cwd, timeoutMs: 120_000 });

/** The branch pull requests target, e.g. "main". */
export async function baseBranch(main: string): Promise<string> {
	const head = await git(main, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
	return head.ok ? head.stdout.replace(/^origin\//, "") : "main";
}

export async function createWorktree(project: string, slug: string, title: string, description: string) {
	const { main, dir, branch } = paths(project, slug);
	if (existsSync(dir)) throw new Error(`worktree already exists: ${dir}`);
	if ((await git(main, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).ok) throw new Error(`branch ${branch} already exists`);

	const fetched = await git(main, "fetch", "--quiet", "origin");
	if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.stderr}`);
	const base = await baseBranch(main);
	mkdirSync(dirname(dir), { recursive: true });
	const added = await git(main, "worktree", "add", "-q", "-b", branch, dir, `origin/${base}`);
	if (!added.ok) throw new Error(`cannot create worktree: ${added.stderr}`);
	// A new branch from origin/<base> would otherwise track <base>, and a plain push would target it.
	await git(dir, "branch", "--unset-upstream");

	const spec = join("docs", "features", `${slug}.md`);
	mkdirSync(dirname(join(dir, spec)), { recursive: true });
	writeFileSync(join(dir, spec), `# ${title}\n\n${description.trim()}\n`);
	await git(dir, "add", "--", spec);
	const commit = await git(dir, "commit", "-q", "-m", `Add spec for ${title}`, "--", spec);
	if (!commit.ok) throw new Error(`cannot commit spec: ${commit.stderr || commit.stdout}`);
	// Work that only exists in the project folder is not part of the feature's starting point.
	const unpushed = Number((await git(main, "rev-list", "--count", `origin/${base}..${base}`)).stdout || 0);
	const dirty = Boolean((await git(main, "status", "--porcelain")).stdout);
	const warnings = [
		unpushed ? `The project folder has ${unpushed} commit(s) that are not on GitHub; this feature starts without them.` : "",
		dirty ? "The project folder has uncommitted changes; this feature starts without them." : "",
	].filter(Boolean);
	return { dir, branch, base, spec, checks: listChecks(project, dir), warnings };
}

export async function worktreeInfo(project: string, slug: string) {
	const { main, dir, branch } = paths(project, slug);
	if (!existsSync(dir)) return { exists: false };
	const base = `origin/${await baseBranch(main)}`;
	const [status, count, stat, diff, log] = await Promise.all([
		git(dir, "status", "--porcelain"),
		git(dir, "rev-list", "--count", `${base}..HEAD`),
		git(dir, "diff", "--numstat", `${base}...HEAD`),
		git(dir, "diff", "--no-color", `${base}...HEAD`),
		git(dir, "log", "--format=%h%x09%an%x09%cI%x09%s", `${base}..HEAD`),
	]);
	return {
		exists: true,
		dir,
		branch,
		base,
		uncommitted: status.stdout ? status.stdout.split("\n").length : 0,
		ahead: Number(count.stdout || 0),
		files: stat.stdout
			? stat.stdout.split("\n").map((line) => {
					const [added, removed, path] = line.split("\t");
					return { path, added: Number(added) || 0, removed: Number(removed) || 0 };
				})
			: [],
		diff: diff.stdout.slice(0, MAX_DIFF),
		diffTruncated: diff.stdout.length > MAX_DIFF,
		commits: log.stdout ? log.stdout.split("\n").map((l) => l.split("\t")).map(([sha, author, at, subject]) => ({ sha, author, at, subject })) : [],
	};
}

/** Commits whatever the agent left uncommitted, then runs every kit check in the worktree. */
export async function checkWorktree(project: string, slug: string) {
	const { main, dir } = paths(project, slug);
	if (!existsSync(dir)) throw new Error("feature worktree not found");
	let savedUncommitted = false;
	if ((await git(dir, "status", "--porcelain")).stdout) {
		await git(dir, "add", "-A");
		savedUncommitted = (await git(dir, "commit", "-q", "-m", "Save uncommitted work from the agent run")).ok;
	}
	const base = `origin/${await baseBranch(main)}`;
	// The spec commit is always there; anything beyond it is the agent's work.
	const ahead = Number((await git(dir, "rev-list", "--count", `${base}..HEAD`)).stdout || 0);
	const results = [];
	for (const check of listChecks(project, dir)) {
		try {
			results.push(await runCheck(project, check.id, dir));
		} catch (err) {
			results.push({ check: check.id, command: check.command, ok: false, code: null, durationMs: 0, output: (err as Error).message });
		}
	}
	return { ahead, savedUncommitted, results };
}

async function prNumber(dir: string, branch: string): Promise<number | null> {
	const view = await gh(dir, "pr", "view", branch, "--json", "number,state");
	if (!view.ok) return null;
	const pr = JSON.parse(view.stdout);
	return pr.state === "OPEN" ? pr.number : null;
}

/** Pushes the feature branch and opens its pull request (or updates the open one by pushing). */
export async function openPr(project: string, slug: string, title: string, body: string) {
	const { main, dir, branch } = paths(project, slug);
	if (!existsSync(dir)) throw new Error("feature worktree not found");
	const pushed = await git(dir, "push", "--quiet", "-u", "origin", `${branch}:${branch}`);
	if (!pushed.ok) throw new Error(`git push failed: ${pushed.stderr}`);
	const existing = await prNumber(dir, branch);
	if (existing === null) {
		const created = await gh(dir, "pr", "create", "--base", await baseBranch(main), "--head", branch, "--title", title, "--body", body);
		if (!created.ok) throw new Error(`gh pr create failed: ${created.stderr}`);
	}
	return prStatus(project, slug);
}

export async function prStatus(project: string, slug: string) {
	const { main, branch } = paths(project, slug);
	const view = await gh(main, "pr", "view", branch, "--json", "number,url,state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision");
	if (!view.ok) return { exists: false, detail: view.stderr };
	const pr = JSON.parse(view.stdout);
	return {
		exists: true,
		number: pr.number as number,
		url: pr.url as string,
		state: pr.state as string, // OPEN, MERGED, CLOSED
		mergeable: pr.mergeable as string, // MERGEABLE, CONFLICTING, UNKNOWN
		mergeState: pr.mergeStateStatus as string,
		checks: (pr.statusCheckRollup ?? []).map((c: any) => ({
			name: c.name ?? c.context ?? "check",
			status: c.status ?? c.state ?? "",
			conclusion: c.conclusion ?? "",
			url: c.detailsUrl ?? c.targetUrl ?? "",
		})),
	};
}

/** Removes the worktree and local branch, and fast-forwards the main folder when that is safe. */
async function cleanup(project: string, slug: string, pull: boolean): Promise<string[]> {
	const { main, dir, branch } = paths(project, slug);
	const notes: string[] = [];
	// If the dev URL is serving this feature, its containers mount the folder that is about to go.
	const servedHere = ((await devStatus(project).catch(() => null)) as { servingFeature?: string } | null)?.servingFeature === slug;
	if (existsSync(dir)) {
		const removed = await git(main, "worktree", "remove", "--force", dir);
		if (!removed.ok) notes.push(`Could not remove the worktree: ${removed.stderr}`);
	}
	await git(main, "worktree", "prune");
	await git(main, "branch", "-D", branch);
	if (pull) {
		const base = await baseBranch(main);
		await git(main, "fetch", "--quiet", "--prune", "origin");
		const current = (await git(main, "rev-parse", "--abbrev-ref", "HEAD")).stdout;
		const dirty = Boolean((await git(main, "status", "--porcelain")).stdout);
		if (current !== base) notes.push(`The project folder is on branch ${current}, so it was not updated.`);
		else if (dirty) notes.push("The project folder has uncommitted changes, so it was not updated. Run git pull there when ready.");
		else if ((await git(main, "merge", "--ff-only", "--quiet", `origin/${base}`)).ok) notes.push(`The project folder is now at the merged ${base}.`);
		// Local commits that are not on GitHub: replay them on top of the merged branch.
		else if ((await git(main, "rebase", "--quiet", `origin/${base}`)).ok) notes.push(`The project folder was rebased onto the merged ${base}; it has local commits that are not pushed.`);
		else {
			await git(main, "rebase", "--abort");
			notes.push("The project folder has local commits that conflict with the merge. Run git pull there and resolve them.");
		}
	}
	if (servedHere) {
		const dev = await devAction(project, "up").catch(() => null);
		notes.push(dev?.ok ? "The dev URL was serving this feature and now serves the project folder again." : "The dev URL was serving this feature; restart the dev environment from the project page.");
	}
	return notes;
}

export async function mergePr(project: string, slug: string) {
	const { main, branch } = paths(project, slug);
	const pr = await prStatus(project, slug);
	if (!pr.exists) throw new Error("no pull request for this feature");
	if (pr.state === "OPEN") {
		const merged = await gh(main, "pr", "merge", String(pr.number), "--squash");
		if (!merged.ok) throw new Error(`merge failed: ${merged.stderr || merged.stdout}`);
	} else if (pr.state !== "MERGED") {
		throw new Error(`pull request is ${pr.state}`);
	}
	await git(main, "push", "--quiet", "origin", "--delete", branch); // may already be gone
	const notes = await cleanup(project, slug, true);
	return { ok: true, notes, pr: await prStatus(project, slug).catch(() => null) };
}

export async function discard(project: string, slug: string) {
	const { main, branch } = paths(project, slug);
	const notes: string[] = [];
	const pr = await prStatus(project, slug);
	if (pr.exists && pr.state === "OPEN") {
		const closed = await gh(main, "pr", "close", String(pr.number));
		notes.push(closed.ok ? `Closed pull request #${pr.number}.` : `Could not close pull request #${pr.number}: ${closed.stderr}`);
	}
	if ((await git(main, "ls-remote", "--exit-code", "--heads", "origin", branch)).ok) await git(main, "push", "--quiet", "origin", "--delete", branch);
	notes.push(...(await cleanup(project, slug, false)));
	return { ok: true, notes };
}
