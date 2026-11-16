export interface Check {
	ok: boolean;
	detail?: string;
	version?: string;
	user?: string;
}
export type Status = Partial<Record<"host" | "claude" | "github" | "docker" | "gateway", Check>> & { host?: Check & { sshTarget?: string } };

export interface Kit {
	name: string;
	version: number;
	description?: string;
	components: Record<string, string[]>;
}

export interface Project {
	id: number;
	name: string;
	repo: string;
	url: string;
	path: string;
	kit: string;
	kit_version: number;
	phase: string;
	created_at: string;
	git: null | {
		exists: boolean;
		branch?: string;
		uncommitted?: number;
		lastCommit?: { sha: string; subject: string; at: string };
		ahead?: number;
		behind?: number;
	};
}

export interface Run {
	id: string;
	project: string;
	prompt: string;
	model: string | null;
	status: string;
	session_id: string | null;
	resume_of: string | null;
	feature_id?: number | null;
	agent?: string | null;
	result_text: string | null;
	tokens_in: number;
	tokens_out: number;
	resets_at: number | null;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
}

export interface RunEvent {
	seq: number;
	at: string;
	type: string;
	payload: any;
}

export interface Feature {
	id: number;
	project: string;
	slug: string;
	title: string;
	description: string;
	model: string | null;
	status: string;
	attempts: number;
	note: string | null;
	pr_number: number | null;
	pr_url: string | null;
	origin: string;
	depends_on: string;
	created_at: string;
	updated_at: string;
}
export interface PrInfo {
	exists: boolean;
	number: number;
	url: string;
	state: string;
	mergeable: string;
	mergeState: string;
	checks: { name: string; status: string; conclusion: string; url: string }[];
}
export interface FeatureDetail extends Feature {
	pr: PrInfo | null;
	runs: Run[];
	round: number;
	checks: { id: number; name: string; command: string; ok: number; code: number | null; duration_ms: number; output: string }[];
	worktree: {
		exists: boolean;
		dir?: string;
		branch?: string;
		base?: string;
		uncommitted?: number;
		ahead?: number;
		files?: { path: string; added: number; removed: number }[];
		diff?: string;
		diffTruncated?: boolean;
		commits?: { sha: string; author: string; at: string; subject: string }[];
	};
}

export type ProjectDetail = Project & { idea: string; runs: Run[]; features: Feature[] };

export interface DevStatus {
	site: string;
	url: string;
	published: boolean;
	hasCompose: boolean;
	state: "none" | "stopped" | "running" | "partial" | "error";
	onEdge: boolean;
	servingFeature?: string;
	edgeNetwork: string;
	services: { service: string; state: string; status: string }[];
	detail?: string;
}
export interface DevActionResult {
	ok: boolean;
	output: string;
	notes: string[];
	status: DevStatus;
}
export interface CheckResult {
	check: string;
	command: string;
	ok: boolean;
	code: number | null;
	durationMs: number;
	output: string;
}
export interface GitDetail {
	exists: boolean;
	branch?: string;
	uncommitted?: number;
	ahead?: number;
	behind?: number;
	changes?: { code: string; path: string }[];
	branches?: { name: string; sha: string; at: string; subject: string }[];
	commits?: { sha: string; author: string; at: string; subject: string }[];
}
export interface FeatureGroup {
	kind: string;
	label: string;
	items: { id: string; summary: string; enabled: boolean; present: boolean; team: string | null }[];
}

export interface Commit {
	sha: string;
	short: string;
	at: string;
	subject: string;
}
export interface Deployment {
	id: number;
	env: string;
	sha: string | null;
	subject: string | null;
	status: string;
	trigger: string;
	log: string;
	rolled_back: number;
	created_at: string;
	ended_at: string | null;
}
export interface EnvStatus {
	env: "preview" | "production";
	url: string;
	published: boolean;
	state: string;
	commit: Commit | null;
	deploying: boolean;
	live: Deployment | null;
	canRollBack: boolean;
	variables: { key: string; updated_at: string }[];
	detail?: string;
}
export interface DeployOverview {
	latest: Commit | null;
	prodAuth: boolean;
	variablesReady: boolean;
	envs: EnvStatus[];
	history: Deployment[];
}

export interface PhaseRun {
	id: string;
	status: string;
	message: string | null;
	model: string | null;
	active: boolean;
}
export interface PhaseOverview {
	phase: string;
	autoBuild: boolean;
	spec: { content: string | null; run: PhaseRun | null };
	plan: { architecture: string | null; items: { title: string; description: string; depends_on: string[] }[] | null; errors: string[]; run: PhaseRun | null };
}

export interface LibItem {
	id: string;
	path: string;
	dir: boolean;
	version?: number;
	description?: string;
}
export interface Team {
	id: string;
	version: number;
	description: string;
	lead?: string;
	components: Record<string, string[]>;
}
export interface TeamsOverview {
	teams: Team[];
	library: Record<string, { id: string; summary: string }[]>;
	/** `teams` is null when the project's folder cannot be read. */
	projects: { name: string; teams: Record<string, number> | null }[];
}
export interface ProjectTeams {
	teams: { id: string; version: number; lead: string | null; latest: number | null; updateAvailable: boolean; components: Record<string, string[]> }[];
	agents: string[];
}
export interface LibTree {
	kits: LibItem[];
	teams: LibItem[];
	components: Record<string, LibItem[]>;
	pending: number;
}
export interface CleanupOverview {
	runs: { id: string; project: string; purpose: string | null; status: string; prompt: string; created_at: string; events: number; bytes: number; keep: string | null }[];
	orphanLogs: { id: string; bytes: number; modified: string; keep: string | null }[];
	worktrees: { project: string; slug: string; bytes: number; modified: string; branch: string | null; uncommitted: number; feature: { id: number; title: string; status: string } | null; keep: string | null }[];
	sessions: { folder: string; where: string; id: string; bytes: number; modified: string; runs: number; keep: string | null }[];
	log: { id: number; at: string; kind: string; target: string; detail: string; bytes: number; ok: number }[];
}
export interface CleanupResult {
	results: { target: string; ok: boolean; bytes?: number; error?: string }[];
}
export interface LibSeed {
	files: { path: string; state: "new" | "differs" }[];
}
export interface LibPending {
	changes: { code: string; path: string }[];
	diff: string;
	errors: string[];
}
export interface KitStatus {
	kit: string;
	version: number;
	latest: number | null;
	updateAvailable: boolean;
	components: { kind: string; id: string; state: "same" | "differs" | "project-only" }[];
}

export interface Step {
	step: string;
	ok: boolean;
	detail?: string;
}
export interface CreateResult {
	ok: boolean;
	steps: Step[];
	error?: string;
}

async function json<T>(res: Response): Promise<T> {
	const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
	if (!res.ok && !("steps" in body)) throw new Error(body.error ?? `HTTP ${res.status}`);
	return body as T;
}

const post = <T>(url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => json<T>(r));

export const ACTIVE = new Set(["queued", "running"]);

export const api = {
	status: () => fetch("/api/status").then((r) => json<Status>(r)),
	kits: () => fetch("/api/kits").then((r) => json<Kit[]>(r)),
	projects: () => fetch("/api/projects").then((r) => json<Project[]>(r)),
	project: (name: string) => fetch(`/api/projects/${name}`).then((r) => json<ProjectDetail>(r)),
	runs: () => fetch("/api/runs").then((r) => json<Run[]>(r)),
	run: (id: string) => fetch(`/api/runs/${id}`).then((r) => json<Run>(r)),
	startRun: (project: string, body: { prompt: string; model?: string; resumeRunId?: string; agent?: string }) => post<Run>(`/api/projects/${project}/runs`, body),
	sendMessage: (id: string, text: string) => post<{ ok: boolean }>(`/api/runs/${id}/message`, { text }),
	interrupt: (id: string) => post<{ ok: boolean }>(`/api/runs/${id}/interrupt`, {}),
	dev: (name: string) => fetch(`/api/projects/${name}/host/dev`).then((r) => json<DevStatus>(r)),
	devAction: (name: string, action: "up" | "stop" | "restart") => post<DevActionResult>(`/api/projects/${name}/host/dev/${action}`, {}),
	devLogs: (name: string) => fetch(`/api/projects/${name}/host/dev/logs`).then((r) => json<{ ok: boolean; logs: string }>(r)),
	checks: (name: string) => fetch(`/api/projects/${name}/host/checks`).then((r) => json<{ id: string; command: string }[]>(r)),
	runCheck: (name: string, id: string) => post<CheckResult>(`/api/projects/${name}/host/checks/${id}`, {}),
	gitDetail: (name: string) => fetch(`/api/projects/${name}/host/git/detail`).then((r) => json<GitDetail>(r)),
	features: (name: string) => fetch(`/api/projects/${name}/host/features`).then((r) => json<FeatureGroup[]>(r)),
	setFeature: (name: string, kind: string, id: string, enabled: boolean) =>
		post<{ ok: boolean; committed: boolean; features: FeatureGroup[] }>(`/api/projects/${name}/host/features`, { kind, id, enabled }),
	createFeature: (project: string, body: { title: string; description: string; model?: string }) => post<Feature>(`/api/projects/${project}/features`, body),
	feature: (id: number) => fetch(`/api/features/${id}`).then((r) => json<FeatureDetail>(r)),
	featureAction: (id: number, action: "recheck" | "approve" | "merge" | "discard" | "preview") => post<unknown>(`/api/features/${id}/${action}`, {}),
	requestChanges: (id: number, text: string) => post<Feature>(`/api/features/${id}/changes`, { text }),
	deployments: (name: string) => fetch(`/api/projects/${name}/deployments`).then((r) => json<DeployOverview>(r)),
	deploy: (name: string, env: string) => post<Deployment>(`/api/projects/${name}/deployments`, { env }),
	rollback: (name: string, env: string) => post<Deployment>(`/api/projects/${name}/deployments/rollback`, { env }),
	stopEnv: (name: string, env: string) => post<unknown>(`/api/projects/${name}/deployments/stop`, { env }),
	setProdAuth: (name: string, on: boolean) => post<unknown>(`/api/projects/${name}/deployments/prod-auth`, { on }),
	setVariable: (name: string, env: string, key: string, value: string) => post<unknown>(`/api/projects/${name}/variables`, { env, key, value }),
	deleteVariable: (name: string, env: string, key: string) => post<unknown>(`/api/projects/${name}/variables/delete`, { env, key }),
	phases: (name: string) => fetch(`/api/projects/${name}/phases`).then((r) => json<PhaseOverview>(r)),
	phaseMessage: (name: string, phase: "spec" | "plan", text: string, model?: string) => post<Run>(`/api/projects/${name}/phases/${phase}/message`, { text, model }),
	phaseApprove: (name: string, phase: "spec" | "plan") => post<unknown>(`/api/projects/${name}/phases/${phase}/approve`, {}),
	setAutoBuild: (name: string, on: boolean) => post<unknown>(`/api/projects/${name}/auto-build`, { on }),
	startFeature: (id: number) => post<Feature>(`/api/features/${id}/start`, {}),
	lib: {
		tree: () => fetch("/api/kitlib/tree").then((r) => json<LibTree>(r)),
		pending: () => fetch("/api/kitlib/pending").then((r) => json<LibPending>(r)),
		files: (path: string) => post<string[]>("/api/kitlib/files", { path }),
		read: (path: string) => post<{ path: string; content: string }>("/api/kitlib/read", { path }),
		write: (path: string, content: string) => post<unknown>("/api/kitlib/write", { path, content }),
		remove: (path: string) => post<unknown>("/api/kitlib/remove", { path }),
		create: (type: string, id: string, from?: string) => post<{ path: string }>("/api/kitlib/create", { type, id, from }),
		commit: (message: string) => post<unknown>("/api/kitlib/commit", { message }),
		discard: () => post<unknown>("/api/kitlib/discard", {}),
		seed: () => fetch("/api/kitlib/seed").then((r) => json<LibSeed>(r)),
		pullSeed: (paths: string[]) => post<LibSeed>("/api/kitlib/pull-seed", { paths }),
		runs: () => fetch("/api/kitlib/runs").then((r) => json<Run[]>(r)),
		startRun: (prompt: string, model?: string) => post<Run>("/api/kitlib/runs", { prompt, model }),
	},
	cleanup: {
		overview: () => fetch("/api/cleanup").then((r) => json<CleanupOverview>(r)),
		runs: (ids: string[]) => post<CleanupResult>("/api/cleanup/runs", { ids }),
		runLogs: (ids: string[]) => post<CleanupResult>("/api/cleanup/run-logs", { ids }),
		worktrees: (items: { project: string; slug: string }[]) => post<CleanupResult>("/api/cleanup/worktrees", { items }),
		sessions: (items: { folder: string; id: string }[]) => post<CleanupResult>("/api/cleanup/sessions", { items }),
	},
	teams: () => fetch("/api/teams").then((r) => json<TeamsOverview>(r)),
	saveTeam: (id: string, body: { description: string; lead: string; components: Record<string, string[]> }) => post<{ team: Team; changed: boolean }>(`/api/teams/${id}`, body),
	projectTeams: (name: string) => fetch(`/api/projects/${name}/host/teams`).then((r) => json<ProjectTeams>(r)),
	setProjectTeam: (name: string, id: string, assign: boolean) => post<ProjectTeams & { committed: boolean; pushed: boolean }>(`/api/projects/${name}/host/teams`, { id, assign }),
	kitStatus: (name: string) => fetch(`/api/projects/${name}/host/kit`).then((r) => json<KitStatus>(r)),
	promote: (name: string, kind: string, id: string) => post<unknown>(`/api/projects/${name}/host/kit/promote`, { kind, id }),
	upgradeKit: (name: string) => post<Feature>(`/api/projects/${name}/kit/upgrade`, {}),
	createProject: (body: { name: string; kit: string; idea: string; visibility: string; teams: string[] }) =>
		fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => json<CreateResult>(r)),
};
