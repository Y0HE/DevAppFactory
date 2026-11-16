import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ProjectRow {
	id: number;
	name: string;
	repo: string;
	url: string;
	path: string;
	kit: string;
	kit_version: number;
	phase: string;
	idea: string;
	prod_auth: number;
	auto_build: number;
	created_at: string;
}

export interface RunRow {
	id: string;
	project_id: number;
	project: string;
	prompt: string;
	model: string | null;
	status: string;
	session_id: string | null;
	resume_of: string | null;
	host_run_id: string | null;
	feature_id: number | null;
	purpose: string | null;
	agent: string | null;
	result_text: string | null;
	tokens_in: number;
	tokens_out: number;
	resets_at: number | null;
	created_at: string;
	started_at: string | null;
	ended_at: string | null;
}

export interface FeatureRow {
	id: number;
	project_id: number;
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
	pr: string | null;
	origin: string;
	depends_on: string;
	created_at: string;
	updated_at: string;
}

export interface CheckRow {
	id: number;
	feature_id: number;
	round: number;
	name: string;
	command: string;
	ok: number;
	code: number | null;
	duration_ms: number;
	output: string;
	at: string;
}

export interface DeploymentRow {
	id: number;
	project_id: number;
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

export interface EventRow {
	seq: number;
	at: string;
	type: string;
	payload: unknown;
}

export type Db = ReturnType<typeof openDb>;

export function openDb(file: string) {
	mkdirSync(dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS projects (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			repo TEXT NOT NULL,
			url TEXT NOT NULL,
			path TEXT NOT NULL,
			kit TEXT NOT NULL,
			kit_version INTEGER NOT NULL,
			phase TEXT NOT NULL DEFAULT 'spec',
			idea TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS runs (
			id TEXT PRIMARY KEY,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			prompt TEXT NOT NULL,
			model TEXT,
			status TEXT NOT NULL,
			session_id TEXT,
			resume_of TEXT,
			host_run_id TEXT,
			result_text TEXT,
			tokens_in INTEGER NOT NULL DEFAULT 0,
			tokens_out INTEGER NOT NULL DEFAULT 0,
			resets_at INTEGER,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			started_at TEXT,
			ended_at TEXT
		);
		CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, created_at);
		CREATE TABLE IF NOT EXISTS events (
			run_id TEXT NOT NULL REFERENCES runs(id),
			seq INTEGER NOT NULL,
			at TEXT NOT NULL,
			type TEXT NOT NULL,
			payload TEXT NOT NULL,
			PRIMARY KEY (run_id, seq)
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS features (
			id INTEGER PRIMARY KEY,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			slug TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			model TEXT,
			status TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			note TEXT,
			pr_number INTEGER,
			pr_url TEXT,
			pr TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			UNIQUE (project_id, slug)
		);
		CREATE TABLE IF NOT EXISTS checks (
			id INTEGER PRIMARY KEY,
			feature_id INTEGER NOT NULL REFERENCES features(id),
			round INTEGER NOT NULL,
			name TEXT NOT NULL,
			command TEXT NOT NULL,
			ok INTEGER NOT NULL,
			code INTEGER,
			duration_ms INTEGER NOT NULL,
			output TEXT NOT NULL,
			at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS deployments (
			id INTEGER PRIMARY KEY,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			env TEXT NOT NULL,
			sha TEXT,
			subject TEXT,
			status TEXT NOT NULL,
			trigger TEXT NOT NULL,
			log TEXT NOT NULL DEFAULT '',
			rolled_back INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			ended_at TEXT
		);
		CREATE INDEX IF NOT EXISTS deployments_env ON deployments(project_id, env, id);
		CREATE TABLE IF NOT EXISTS env_vars (
			project_id INTEGER NOT NULL REFERENCES projects(id),
			env TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			PRIMARY KEY (project_id, env, key)
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS cleanup_log (
			id INTEGER PRIMARY KEY,
			at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			kind TEXT NOT NULL,
			target TEXT NOT NULL,
			detail TEXT NOT NULL DEFAULT '',
			bytes INTEGER NOT NULL DEFAULT 0,
			ok INTEGER NOT NULL DEFAULT 1
		);
	`);
	const projectColumns = (db.prepare("PRAGMA table_info(projects)").all() as any[]).map((c) => c.name);
	if (!projectColumns.includes("prod_auth")) db.exec("ALTER TABLE projects ADD COLUMN prod_auth INTEGER NOT NULL DEFAULT 1");
	// Columns added after the first release.
	const runColumns = (db.prepare("PRAGMA table_info(runs)").all() as any[]).map((c) => c.name);
	if (!runColumns.includes("feature_id")) db.exec("ALTER TABLE runs ADD COLUMN feature_id INTEGER REFERENCES features(id)");
	if (!runColumns.includes("purpose")) db.exec("ALTER TABLE runs ADD COLUMN purpose TEXT");
	if (!runColumns.includes("agent")) db.exec("ALTER TABLE runs ADD COLUMN agent TEXT");
	if (!projectColumns.includes("auto_build")) db.exec("ALTER TABLE projects ADD COLUMN auto_build INTEGER NOT NULL DEFAULT 1");
	const featureColumns = (db.prepare("PRAGMA table_info(features)").all() as any[]).map((c) => c.name);
	if (!featureColumns.includes("origin")) db.exec("ALTER TABLE features ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
	if (!featureColumns.includes("depends_on")) db.exec("ALTER TABLE features ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'");

	const FEATURE = "SELECT features.*, projects.name AS project FROM features JOIN projects ON projects.id = features.project_id";
	const RUN = "SELECT runs.*, projects.name AS project FROM runs JOIN projects ON projects.id = runs.project_id";
	return {
		setProdAuth: (projectId: number, on: boolean) => db.prepare("UPDATE projects SET prod_auth = ? WHERE id = ?").run(on ? 1 : 0, projectId),
		insertDeployment: (d: { project_id: number; env: string; sha: string | null; status: string; trigger: string }) =>
			Number(db.prepare("INSERT INTO deployments (project_id, env, sha, status, trigger) VALUES (?, ?, ?, ?, ?)").run(d.project_id, d.env, d.sha, d.status, d.trigger).lastInsertRowid),
		updateDeployment: (id: number, fields: Partial<Omit<DeploymentRow, "id" | "project_id">>) =>
			db.prepare(`UPDATE deployments SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(fields) as any[]), id),
		listDeployments: (projectId: number, limit = 30) => db.prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as unknown as DeploymentRow[],
		/** Successful deployments of one environment, newest first. */
		liveDeployments: (projectId: number, env: string) =>
			db.prepare("SELECT * FROM deployments WHERE project_id = ? AND env = ? AND status = 'live' ORDER BY id DESC LIMIT 20").all(projectId, env) as unknown as DeploymentRow[],
		deploymentsByStatus: (status: string) => db.prepare("SELECT * FROM deployments WHERE status = ?").all(status) as unknown as DeploymentRow[],
		listVars: (projectId: number, env: string) => db.prepare("SELECT key, value, updated_at FROM env_vars WHERE project_id = ? AND env = ? ORDER BY key").all(projectId, env) as unknown as { key: string; value: string; updated_at: string }[],
		setVar: (projectId: number, env: string, key: string, value: string) =>
			db.prepare("INSERT INTO env_vars (project_id, env, key, value) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, env, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run(projectId, env, key, value),
		deleteVar: (projectId: number, env: string, key: string) => db.prepare("DELETE FROM env_vars WHERE project_id = ? AND env = ? AND key = ?").run(projectId, env, key),
		getProject: (name: string) => db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as unknown as ProjectRow | undefined,
		insertRun: (r: { id: string; project_id: number; prompt: string; model: string | null; status: string; session_id: string | null; resume_of: string | null; feature_id: number | null; purpose: string | null; agent?: string | null }) =>
			db
				.prepare("INSERT INTO runs (id, project_id, prompt, model, status, session_id, resume_of, feature_id, purpose, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(r.id, r.project_id, r.prompt, r.model, r.status, r.session_id, r.resume_of, r.feature_id, r.purpose, r.agent ?? null),
		lastRunFor: (projectId: number, purpose: string) => db.prepare(`${RUN} WHERE runs.project_id = ? AND runs.purpose = ? ORDER BY runs.created_at DESC LIMIT 1`).get(projectId, purpose) as unknown as RunRow | undefined,
		setProject: (projectId: number, fields: { phase?: string; auto_build?: number }) =>
			db.prepare(`UPDATE projects SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(fields) as any[]), projectId),
		projectsInPhase: (phase: string) => db.prepare("SELECT * FROM projects WHERE phase = ?").all(phase) as unknown as ProjectRow[],
		insertFeature: (f: { project_id: number; slug: string; title: string; description: string; model: string | null; status: string; origin?: string; depends_on?: string[] }) =>
			Number(
				db
					.prepare("INSERT INTO features (project_id, slug, title, description, model, status, origin, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
					.run(f.project_id, f.slug, f.title, f.description, f.model, f.status, f.origin ?? "manual", JSON.stringify(f.depends_on ?? [])).lastInsertRowid,
			),
		updateFeature: (id: number, fields: Partial<Omit<FeatureRow, "id" | "project" | "project_id">>) => {
			const all = { ...fields, updated_at: new Date().toISOString() };
			db.prepare(`UPDATE features SET ${Object.keys(all).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(all) as any[]), id);
		},
		getFeature: (id: number) => db.prepare(`${FEATURE} WHERE features.id = ?`).get(id) as unknown as FeatureRow | undefined,
		listFeatures: (project: string) => db.prepare(`${FEATURE} WHERE projects.name = ? ORDER BY features.id DESC`).all(project) as unknown as FeatureRow[],
		featuresByStatus: (status: string) => db.prepare(`${FEATURE} WHERE features.status = ?`).all(status) as unknown as FeatureRow[],
		featureRuns: (featureId: number) => db.prepare(`${RUN} WHERE runs.feature_id = ? ORDER BY runs.created_at`).all(featureId) as unknown as RunRow[],
		insertCheck: (c: Omit<CheckRow, "id" | "at">) =>
			db.prepare("INSERT INTO checks (feature_id, round, name, command, ok, code, duration_ms, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(c.feature_id, c.round, c.name, c.command, c.ok, c.code, c.duration_ms, c.output),
		listChecks: (featureId: number) => db.prepare("SELECT * FROM checks WHERE feature_id = ? ORDER BY round DESC, id").all(featureId) as unknown as CheckRow[],
		lastRound: (featureId: number) => ((db.prepare("SELECT MAX(round) AS r FROM checks WHERE feature_id = ?").get(featureId) as any)?.r ?? 0) as number,
		updateRun: (id: string, fields: Partial<Omit<RunRow, "id" | "project" | "project_id">>) => {
			const keys = Object.keys(fields);
			if (!keys.length) return;
			db.prepare(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(fields) as any[]), id);
		},
		/** Every run with the number and size of its stored events, newest first. */
		allRuns: () =>
			db
				.prepare(`SELECT runs.*, projects.name AS project, (SELECT COUNT(*) FROM events WHERE events.run_id = runs.id) AS events, (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM events WHERE events.run_id = runs.id) AS event_bytes FROM runs JOIN projects ON projects.id = runs.project_id ORDER BY runs.created_at DESC`)
				.all() as unknown as (RunRow & { events: number; event_bytes: number })[],
		allFeatures: () => db.prepare(FEATURE).all() as unknown as FeatureRow[],
		/** Removes a run with its events. Runs resumed from it keep working: they have their own session id. */
		deleteRun: (id: string) => {
			db.prepare("DELETE FROM events WHERE run_id = ?").run(id);
			db.prepare("UPDATE runs SET resume_of = NULL WHERE resume_of = ?").run(id);
			db.prepare("DELETE FROM runs WHERE id = ?").run(id);
		},
		logCleanup: (e: { kind: string; target: string; detail?: string; bytes?: number; ok?: boolean }) =>
			db.prepare("INSERT INTO cleanup_log (kind, target, detail, bytes, ok) VALUES (?, ?, ?, ?, ?)").run(e.kind, e.target, e.detail ?? "", e.bytes ?? 0, e.ok === false ? 0 : 1),
		cleanupLog: (limit = 200) => db.prepare("SELECT * FROM cleanup_log ORDER BY id DESC LIMIT ?").all(limit) as unknown as { id: number; at: string; kind: string; target: string; detail: string; bytes: number; ok: number }[],
		getRun: (id: string) => db.prepare(`${RUN} WHERE runs.id = ?`).get(id) as unknown as RunRow | undefined,
		listRuns: (project?: string) =>
			(project
				? db.prepare(`${RUN} WHERE projects.name = ? ORDER BY runs.created_at DESC LIMIT 100`).all(project)
				: db.prepare(`${RUN} ORDER BY runs.created_at DESC LIMIT 100`).all()) as unknown as RunRow[],
		runsByStatus: (...statuses: string[]) =>
			db.prepare(`${RUN} WHERE runs.status IN (${statuses.map(() => "?").join(", ")}) ORDER BY runs.created_at`).all(...statuses) as unknown as RunRow[],
		insertEvent: (runId: string, e: EventRow) =>
			db.prepare("INSERT OR IGNORE INTO events (run_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)").run(runId, e.seq, e.at, e.type, JSON.stringify(e.payload)),
		listEvents: (runId: string, after = -1) =>
			(db.prepare("SELECT seq, at, type, payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, after) as any[]).map(
				(row): EventRow => ({ seq: row.seq, at: row.at, type: row.type, payload: JSON.parse(row.payload) }),
			),
		lastSeq: (runId: string) => ((db.prepare("SELECT MAX(seq) AS seq FROM events WHERE run_id = ?").get(runId) as any)?.seq ?? -1) as number,
		listProjects: () => db.prepare("SELECT * FROM projects WHERE name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY created_at DESC, id DESC").all() as unknown as ProjectRow[],
		/** A hidden project row that agent runs on the kit library hang off. */
		ensureSystemProject: (name: string, path: string) =>
			db.prepare("INSERT OR IGNORE INTO projects (name, repo, url, path, kit, kit_version, idea, phase) VALUES (?, '', '', ?, '', 0, '', 'operate')").run(name, path),
		insertProject: (p: Omit<ProjectRow, "id" | "phase" | "created_at" | "prod_auth" | "auto_build">) =>
			db
				.prepare("INSERT INTO projects (name, repo, url, path, kit, kit_version, idea) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.run(p.name, p.repo, p.url, p.path, p.kit, p.kit_version, p.idea),
	};
}
