// Feature pipeline: building -> checking -> review -> pr_open -> merged.
// Agents propose; the checks, the user's review and the pull request decide.
import type { CheckRow, Db, FeatureRow, RunRow } from "./db.js";
import type { HostClient } from "./host.js";

const MAX_FIX_ROUNDS = 3;
type Runs = { create: (project: string, body: { prompt?: string; model?: string | null; resumeRunId?: string; featureId?: number }) => RunRow; onEnd: (fn: (run: RunRow) => void) => void; interrupt: (id: string) => Promise<unknown> };

interface CheckResult {
	check: string;
	command: string;
	ok: boolean;
	code: number | null;
	durationMs: number;
	output: string;
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

export function featureService(db: Db, host: HostClient, runs: Runs, onMerged: (project: string) => void = () => {}) {
	const wt = (f: FeatureRow, rest = "") => `/projects/${f.project}/worktrees/${f.slug}${rest}`;
	const set = (id: number, fields: Parameters<Db["updateFeature"]>[1]) => db.updateFeature(id, fields);
	const stuck = (id: number, note: string) => set(id, { status: "needs_attention", note });
	const lastRun = (f: FeatureRow) => db.featureRuns(f.id).at(-1);

	function startRun(f: FeatureRow, prompt: string) {
		const previous = lastRun(f);
		runs.create(f.project, { prompt, model: f.model, featureId: f.id, resumeRunId: previous?.session_id ? previous.id : undefined });
		set(f.id, { status: "building", note: null });
	}

	/** Runs the kit checks in the worktree and moves the feature on according to the result. */
	async function check(f: FeatureRow, autoFix: boolean) {
		set(f.id, { status: "checking", note: null });
		let outcome: { ahead: number; savedUncommitted: boolean; results: CheckResult[] };
		try {
			outcome = await host.post(wt(f, "/check"), {});
		} catch (err) {
			return stuck(f.id, `Checks could not run: ${(err as Error).message}`);
		}
		const round = db.lastRound(f.id) + 1;
		for (const r of outcome.results) {
			db.insertCheck({ feature_id: f.id, round, name: r.check, command: r.command, ok: r.ok ? 1 : 0, code: r.code, duration_ms: r.durationMs, output: r.output.slice(-20_000) });
		}
		// Commit 1 is the spec the factory wrote; the agent's work starts at 2.
		if (outcome.ahead <= 1) return stuck(f.id, "The agent finished without changing anything.");

		const failed = outcome.results.filter((r) => !r.ok);
		if (failed.length === 0) return set(f.id, { status: "review", attempts: 0, note: outcome.results.length === 0 ? "This project defines no checks, so nothing was verified automatically." : null });

		const attempts = f.attempts + 1;
		set(f.id, { attempts });
		if (!autoFix || attempts >= MAX_FIX_ROUNDS) {
			return stuck(f.id, `${failed.length} check(s) failed${autoFix ? ` after ${attempts} rounds` : ""}: ${failed.map((r) => r.check).join(", ")}.`);
		}
		const report = failed.map((r) => `## ${r.check} (\`${r.command}\`, exit code ${r.code})\n\n${r.output.slice(-3000) || "(no output)"}`).join("\n\n");
		startRun(db.getFeature(f.id)!, `The project's checks failed after your changes. Fix the cause and commit. Do not weaken or remove the checks.\n\n${report}`);
	}

	runs.onEnd((run) => {
		if (!run.feature_id) return;
		const f = db.getFeature(run.feature_id);
		if (!f || f.status !== "building") return;
		if (run.status === "succeeded") void check(f, true);
		else if (run.status === "interrupted") stuck(f.id, "The agent was stopped.");
		else if (run.status === "paused_limit") stuck(f.id, "The Claude usage limit was reached. Send an instruction to continue once it has reset.");
		else if (run.status === "auth_required") stuck(f.id, "Claude Code is not logged in on the server.");
		else stuck(f.id, "The agent run failed.");
	});

	async function pollOne(f: FeatureRow) {
		const pr = await host.get<any>(wt(f, "/pr")).catch(() => null);
		if (!pr?.exists) return;
		set(f.id, { pr: JSON.stringify(pr), pr_number: pr.number, pr_url: pr.url });
		if (pr.state === "MERGED") {
			const res = await host.post<{ notes: string[] }>(wt(f, "/merge"), {}).catch((err) => ({ notes: [(err as Error).message] }));
			set(f.id, { status: "merged", note: ["Merged on GitHub.", ...res.notes].join(" ") });
			onMerged(f.project);
		} else if (pr.state === "CLOSED") {
			stuck(f.id, "The pull request was closed on GitHub without merging.");
		}
	}

	/** Creates the feature's worktree and starts its first agent run. */
	async function begin(f: FeatureRow) {
		const created = await host.post<{ spec: string; checks: { id: string; command: string }[]; warnings: string[] }>(`/projects/${f.project}/worktrees`, {
			slug: f.slug,
			title: f.title,
			description: f.description,
		});
		const checks = created.checks.length ? `The project's checks are: ${created.checks.map((c) => `\`${c.command}\``).join(", ")}. Make sure they pass.` : "";
		startRun(
			f,
			`Implement the feature specified in ${created.spec}. You are in a dedicated git worktree on branch feature/${f.slug}. Read docs/spec.md and docs/architecture.md first when they exist. Follow the project's rules. ${checks} Commit your work with clear messages when you are done. Do not push.`,
		);
		if (created.warnings.length) set(f.id, { note: created.warnings.join(" ") });
	}

	return {
		async create(project: string, body: { title?: string; description?: string; model?: string }) {
			const row = db.getProject(project);
			if (!row) throw new Error("project not found");
			const title = (body.title ?? "").trim();
			const description = (body.description ?? "").trim();
			if (!title || !description) throw new Error("title and description are required");
			let slug = slugify(title);
			if (!slug) throw new Error("the title needs at least one letter or digit");
			const taken = new Set(db.listFeatures(project).map((f) => f.slug));
			for (let n = 2; taken.has(slug); n++) slug = `${slugify(title).slice(0, 36)}-${n}`;

			const id = db.insertFeature({ project_id: row.id, slug, title, description, model: body.model?.trim() || null, status: "planned" });
			try {
				await begin(db.getFeature(id)!);
			} catch (err) {
				db.updateFeature(id, { status: "cancelled", note: (err as Error).message });
				throw err;
			}
			return db.getFeature(id)!;
		},

		/** Adds the features of an approved plan, in order, without starting them. */
		addPlanned(project: string, items: { title: string; description: string; depends_on: string[] }[], model: string | null) {
			const row = db.getProject(project);
			if (!row) throw new Error("project not found");
			const taken = new Set(db.listFeatures(project).map((f) => f.slug));
			const slugOf = new Map<string, string>();
			for (const item of items) {
				let slug = slugify(item.title) || "feature";
				for (let n = 2; taken.has(slug); n++) slug = `${(slugify(item.title) || "feature").slice(0, 36)}-${n}`;
				taken.add(slug);
				slugOf.set(item.title, slug);
			}
			for (const item of items) {
				db.insertFeature({
					project_id: row.id,
					slug: slugOf.get(item.title)!,
					title: item.title,
					description: item.description,
					model,
					status: "planned",
					origin: "plan",
					depends_on: item.depends_on.map((t) => slugOf.get(t)!).filter(Boolean),
				});
			}
		},

		/** Opens a feature whose branch the factory fills itself: the project's kit brought up to the library's version. */
		async createUpgrade(project: string) {
			const row = db.getProject(project);
			if (!row) throw new Error("project not found");
			const status = await host.get<{ kit: string; version: number; latest: number | null; updateAvailable: boolean }>(`/projects/${project}/kit`);
			if (!status.updateAvailable) throw new Error("this project already has the latest version of its kit");
			const title = `Upgrade kit ${status.kit} to version ${status.latest}`;
			const base = slugify(title);
			const taken = new Set(db.listFeatures(project).map((f) => f.slug));
			let slug = base;
			for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 36)}-${n}`;
			const description = `Refresh the project's enabled rules, skills, subagents and workflows from the kit library, and update the kit record (version ${status.version} to ${status.latest}, checks, runtime and allowed commands). The app's own files are not changed.`;
			const id = db.insertFeature({ project_id: row.id, slug, title, description, model: null, status: "checking", origin: "kit" });
			try {
				await host.post(`/projects/${project}/worktrees`, { slug, title, description });
				const res = await host.post<{ skipped: string[] }>(wt(db.getFeature(id)!, "/upgrade"), {});
				await check(db.getFeature(id)!, false);
				if (res.skipped.length) set(id, { note: `Not in the library any more, left as they are: ${res.skipped.join(", ")}.` });
			} catch (err) {
				stuck(id, (err as Error).message);
			}
			return db.getFeature(id)!;
		},

		/** Starts a planned feature now. */
		async startPlanned(id: number) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			if (f.status !== "planned") throw new Error(`this feature is ${f.status}, not planned`);
			await begin(f);
			return db.getFeature(id)!;
		},

		async detail(id: number) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			const live = ["cancelled", "merged"].includes(f.status) ? { exists: false } : await host.get<any>(wt(f)).catch((err) => ({ exists: false, error: (err as Error).message }));
			const checks = db.listChecks(f.id);
			const round = checks[0]?.round ?? 0;
			return { ...f, pr: f.pr ? JSON.parse(f.pr) : null, runs: db.featureRuns(f.id), checks: checks.filter((c: CheckRow) => c.round === round), round, worktree: live };
		},

		/** The user asks for more work: resumes the agent's session with their text. */
		requestChanges(id: number, text: string) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			if (!["review", "pr_open", "needs_attention"].includes(f.status)) throw new Error(`cannot request changes while the feature is ${f.status}`);
			if (!text.trim()) throw new Error("say what should change");
			set(f.id, { attempts: 0 });
			startRun(db.getFeature(id)!, `${text.trim()}\n\nCommit your work when you are done. Do not push.`);
			return db.getFeature(id)!;
		},

		async recheck(id: number) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			if (!["review", "needs_attention"].includes(f.status)) throw new Error(`cannot re-run checks while the feature is ${f.status}`);
			await check(f, false);
			return db.getFeature(id)!;
		},

		/** The user approves the diff: push the branch and open (or update) the pull request. */
		async approve(id: number) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			if (f.status !== "review") throw new Error(`only a feature in review can be approved (this one is ${f.status})`);
			const body = `${f.description}\n\n---\nBuilt with DevAppFactory. Spec: \`docs/features/${f.slug}.md\``;
			const pr = await host.post<any>(wt(f, "/pr"), { title: f.title, body });
			set(f.id, { status: "pr_open", pr: JSON.stringify(pr), pr_number: pr.number ?? null, pr_url: pr.url ?? null, note: null });
			return db.getFeature(id)!;
		},

		async merge(id: number) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			if (f.status !== "pr_open") throw new Error(`only a feature with an open pull request can be merged (this one is ${f.status})`);
			const res = await host.post<{ notes: string[]; pr?: unknown }>(wt(f, "/merge"), {});
			set(f.id, { status: "merged", note: res.notes.join(" ") || null, ...(res.pr ? { pr: JSON.stringify(res.pr) } : {}) });
			onMerged(f.project);
			return db.getFeature(id)!;
		},

		async discard(id: number) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			if (["merged", "cancelled"].includes(f.status)) throw new Error(`the feature is already ${f.status}`);
			if (f.status === "planned") {
				set(f.id, { status: "cancelled", note: "Removed from the plan before it was started." });
				return db.getFeature(id)!;
			}
			const active = db.featureRuns(f.id).filter((r) => r.status === "running" || r.status === "queued");
			set(f.id, { status: "cancelled" }); // first, so the run-end handler leaves it alone
			for (const r of active) await runs.interrupt(r.id).catch(() => {});
			if (active.length) await new Promise((resolve) => setTimeout(resolve, 3000)); // let the agent exit before its folder goes
			const res = await host.post<{ notes: string[] }>(wt(f, "/discard"), {});
			set(f.id, { note: res.notes.join(" ") || null });
			return db.getFeature(id)!;
		},

		preview(id: number) {
			const f = db.getFeature(id);
			if (!f) throw new Error("feature not found");
			return host.post(`/projects/${f.project}/dev/up`, { feature: f.slug });
		},

		/** Mirrors pull request state from GitHub. */
		startPolling(everyMs = 30_000) {
			const tick = async () => {
				for (const f of db.featuresByStatus("pr_open")) await pollOne(f).catch(() => {});
			};
			setInterval(() => void tick(), everyMs).unref();
		},

		/** After a restart: features whose agent or checks were in flight cannot continue on their own. */
		recover() {
			for (const f of db.featuresByStatus("checking")) stuck(f.id, "The factory restarted while checks were running. Re-run the checks.");
			for (const f of db.featuresByStatus("building")) {
				const run = lastRun(f);
				if (!run || !["running", "queued"].includes(run.status)) stuck(f.id, "The factory restarted while the agent was working. Send an instruction to continue.");
			}
		},
	};
}
