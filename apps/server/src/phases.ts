// Spec and plan phases: a conversation with an agent that ends in approved documents,
// and the build order of the features the plan produces.
import type { Db, FeatureRow, ProjectRow, RunRow } from "./db.js";
import type { HostClient } from "./host.js";

type Runs = { create: (project: string, body: { prompt?: string; model?: string | null; resumeRunId?: string; purpose?: string }) => RunRow };
type Features = {
	addPlanned: (project: string, items: PlanItem[], model: string | null) => void;
	startPlanned: (id: number) => Promise<unknown>;
};
interface PlanItem {
	title: string;
	description: string;
	depends_on: string[];
}
type Phase = "spec" | "plan";

const DOCS: Record<Phase, string[]> = { spec: ["docs/spec.md"], plan: ["docs/architecture.md", "docs/plan.json"] };
const ACTIVE = new Set(["queued", "running"]);

const PROMPT: Record<Phase, string> = {
	spec: `You are writing the product specification for this project. Read docs/idea.md and anything else in the repository that helps.

If information you cannot reasonably assume is missing, ask the user at most 5 short numbered questions and stop there, without writing the spec. Otherwise write docs/spec.md with these sections:

- Summary: what the app is and who it is for, in a few sentences.
- Users and their goals.
- Scope: what is in the first version, and what is explicitly out.
- Acceptance criteria: a numbered list (AC-1, AC-2, ...). Each one is a single observable behaviour that can be checked.
- Assumptions you made.

Keep it under 150 lines. Do not write code, do not change files outside docs/, and do not commit. Finish with a short message to the user: either your questions, or what you wrote and the assumptions they should check.`,
	plan: `The specification in docs/spec.md has been approved. Plan how to build it. Read the project's rules and its current files first.

Write two files:

1. docs/architecture.md: the stack and why, the main components, the data model, how the app runs under docker compose, and the key decisions. Stay consistent with the project's rules and existing scaffold. Under 120 lines.
2. docs/plan.json: a JSON array of features to build, in order. Each element is {"title": string, "description": string, "depends_on": [titles of earlier features]}.

Rules for the features: 3 to 12 of them. Each is small enough for one pull request and leaves the app working. The first sets up the skeleton. Each description says what to build, which acceptance criteria (AC ids) it covers, and how to verify it. Titles are unique and short. Use depends_on only for real dependencies.

Do not write code, do not change files outside docs/, and do not commit. Finish with a short message to the user summarising the architecture and the feature list.`,
};

/** Checks docs/plan.json. Returns the features, or the reasons it cannot be used. */
export function parsePlan(text: string): { items: PlanItem[]; errors: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { items: [], errors: [`docs/plan.json is not valid JSON: ${(err as Error).message}`] };
	}
	if (!Array.isArray(raw)) return { items: [], errors: ["docs/plan.json must be a JSON array of features."] };
	const errors: string[] = [];
	if (raw.length < 1 || raw.length > 20) errors.push(`The plan has ${raw.length} features; it must have between 1 and 20.`);
	const items: PlanItem[] = raw.map((r: any, i) => {
		const title = typeof r?.title === "string" ? r.title.trim() : "";
		const description = typeof r?.description === "string" ? r.description.trim() : "";
		if (!title) errors.push(`Feature ${i + 1} has no title.`);
		if (!description) errors.push(`Feature ${i + 1}${title ? ` (${title})` : ""} has no description.`);
		const deps = Array.isArray(r?.depends_on) ? r.depends_on.filter((d: unknown) => typeof d === "string").map((d: string) => d.trim()) : [];
		return { title, description, depends_on: deps };
	});
	const titles = items.map((i) => i.title);
	for (const t of new Set(titles.filter((t, i) => t && titles.indexOf(t) !== i))) errors.push(`The title "${t}" is used more than once.`);
	items.forEach((item, i) => {
		for (const dep of item.depends_on) {
			const at = titles.indexOf(dep);
			if (at < 0) errors.push(`"${item.title}" depends on "${dep}", which is not in the plan.`);
			// Requiring dependencies to come earlier also rules out cycles.
			else if (at >= i) errors.push(`"${item.title}" depends on "${dep}", which must come before it in the list.`);
		}
	});
	return { items, errors };
}

export function phaseService(db: Db, host: HostClient, runs: Runs, features: Features) {
	function project(name: string): ProjectRow {
		const row = db.getProject(name);
		if (!row) throw new Error("project not found");
		return row;
	}
	const readDoc = (name: string, path: string) => host.post<{ exists: boolean; content?: string }>(`/projects/${name}/docs/read`, { path });

	function converse(name: string, phase: Phase, text: string, model?: string) {
		const row = project(name);
		const last = db.lastRunFor(row.id, phase);
		if (last && ACTIVE.has(last.status)) throw new Error("the agent is still working");
		const first = !last?.session_id;
		if (!first && !text.trim()) throw new Error("write a reply for the agent");
		const prompt = first ? `${PROMPT[phase]}${text.trim() ? `\n\nNote from the user: ${text.trim()}` : ""}` : text.trim();
		return runs.create(name, { prompt, model: model?.trim() || last?.model || null, resumeRunId: first ? undefined : last!.id, purpose: phase });
	}

	/** Starts the next planned feature when the project is building and nothing planned is in progress. */
	async function advance(row: ProjectRow) {
		const all = db.listFeatures(row.name).filter((f) => f.origin === "plan");
		const open = all.filter((f) => f.status !== "cancelled");
		if (row.phase === "build" && open.length > 0 && open.every((f) => f.status === "merged")) {
			db.setProject(row.id, { phase: "release" });
			return;
		}
		if (row.phase !== "build" || !row.auto_build) return;
		if (open.some((f) => ["building", "checking"].includes(f.status))) return;
		const merged = new Set(all.filter((f) => f.status === "merged").map((f) => f.slug));
		const cancelled = new Set(all.filter((f) => f.status === "cancelled").map((f) => f.slug));
		const ready = (f: FeatureRow) => (JSON.parse(f.depends_on) as string[]).every((d) => merged.has(d) || cancelled.has(d));
		const next = open.filter((f) => f.status === "planned" && ready(f)).sort((a, b) => a.id - b.id)[0];
		if (next) await features.startPlanned(next.id).catch(() => {});
	}

	return {
		parsePlan,

		async overview(name: string) {
			const row = project(name);
			const [spec, architecture, planDoc] = await Promise.all([readDoc(name, "docs/spec.md"), readDoc(name, "docs/architecture.md"), readDoc(name, "docs/plan.json")].map((p) => p.catch(() => ({ exists: false, content: undefined }))));
			const plan = planDoc.exists ? parsePlan(planDoc.content ?? "") : null;
			const run = (phase: Phase) => {
				const r = db.lastRunFor(row.id, phase);
				return r ? { id: r.id, status: r.status, message: r.result_text, model: r.model, active: ACTIVE.has(r.status) } : null;
			};
			return {
				phase: row.phase,
				autoBuild: row.auto_build === 1,
				spec: { content: spec.exists ? spec.content : null, run: run("spec") },
				plan: { architecture: architecture.exists ? architecture.content : null, items: plan?.items ?? null, errors: plan?.errors ?? [], run: run("plan") },
			};
		},

		start: (name: string, phase: Phase, body: { text?: string; model?: string }) => converse(name, phase, body.text ?? "", body.model),

		/** The user accepts the phase's documents: commit and push them, then move on. */
		async approve(name: string, phase: Phase) {
			const row = project(name);
			const last = db.lastRunFor(row.id, phase);
			if (last && ACTIVE.has(last.status)) throw new Error("the agent is still working");
			if (phase === "spec") {
				if (!(await readDoc(name, "docs/spec.md")).exists) throw new Error("there is no docs/spec.md to approve yet");
				await host.post(`/projects/${name}/docs/commit`, { paths: DOCS.spec, message: "Approve specification" });
				if (row.phase === "spec") db.setProject(row.id, { phase: "plan" });
				// Planning follows directly; the user reviews its result next.
				if (!db.lastRunFor(row.id, "plan")) converse(name, "plan", "", last?.model ?? undefined);
				return { ok: true };
			}
			const doc = await readDoc(name, "docs/plan.json");
			if (!doc.exists) throw new Error("there is no docs/plan.json to approve yet");
			const { items, errors } = parsePlan(doc.content ?? "");
			if (errors.length) throw new Error(`The plan cannot be approved: ${errors.join(" ")}`);
			if (db.listFeatures(name).some((f) => f.origin === "plan" && f.status !== "cancelled")) throw new Error("a plan has already been approved for this project");
			const paths = (await readDoc(name, "docs/architecture.md")).exists ? DOCS.plan : ["docs/plan.json"];
			await host.post(`/projects/${name}/docs/commit`, { paths, message: "Approve architecture and plan" });
			features.addPlanned(name, items, last?.model ?? null);
			db.setProject(row.id, { phase: "build" });
			void advance(project(name));
			return { ok: true };
		},

		setAutoBuild(name: string, on: boolean) {
			const row = project(name);
			db.setProject(row.id, { auto_build: on ? 1 : 0 });
			if (on) void advance(project(name));
			return { ok: true };
		},

		/** A production deployment went live. */
		released(name: string) {
			const row = db.getProject(name);
			if (row && ["build", "release"].includes(row.phase)) db.setProject(row.id, { phase: "operate" });
		},

		startTicking(everyMs = 15_000) {
			setInterval(() => {
				for (const row of db.projectsInPhase("build")) void advance(row).catch(() => {});
			}, everyMs).unref();
		},
	};
}
