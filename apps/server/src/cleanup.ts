// Cleanup: what agent runs, worktrees and Claude sessions take up, which of them are still needed,
// and deleting the rest. Every deletion is written to a log that the Cleanup page shows.
import type { Db, FeatureRow, RunRow } from "./db.js";

type Host = { get: <T>(path: string) => Promise<T>; post: <T>(path: string, body: unknown) => Promise<T> };

interface Disk {
	runLogs: { id: string; bytes: number; modified: string; active: boolean }[];
	worktrees: { project: string; slug: string; bytes: number; modified: string; branch: string | null; uncommitted: number }[];
	sessions: { folder: string; where: string; id: string; bytes: number; modified: string }[];
}

const ACTIVE = new Set(["queued", "running"]);
const CLOSED = new Set(["merged", "cancelled"]);

export function cleanupService(db: Db, host: Host) {
	/** Why a run must stay, or null when it can be deleted. */
	function keepReasons() {
		const features = new Map<number, FeatureRow>(db.allFeatures().map((f) => [f.id, f]));
		const runs = db.allRuns();
		// The spec and plan conversations of a project continue from their latest run.
		const latestPhase = new Set<string>();
		const seen = new Set<string>();
		for (const r of runs) {
			if (r.purpose !== "spec" && r.purpose !== "plan") continue;
			const key = `${r.project_id}/${r.purpose}`;
			if (!seen.has(key)) latestPhase.add(r.id);
			seen.add(key);
		}
		const reason = (r: RunRow): string | null => {
			if (ACTIVE.has(r.status)) return "still active";
			const f = r.feature_id ? features.get(r.feature_id) : undefined;
			if (f && !CLOSED.has(f.status)) return `feature "${f.title}" is still open`;
			if (latestPhase.has(r.id)) return `latest ${r.purpose} conversation of the project`;
			return null;
		};
		return { runs, features, reason };
	}

	async function overview() {
		const disk = await host.get<Disk>("/cleanup");
		const { runs, features, reason } = keepReasons();
		const logBytes = new Map(disk.runLogs.map((l) => [l.id, l.bytes]));
		const knownLogs = new Set(runs.map((r) => r.host_run_id).filter(Boolean));
		const keptSessions = new Map<string, string>();
		const sessionRuns = new Map<string, number>();
		for (const r of runs) {
			if (!r.session_id) continue;
			sessionRuns.set(r.session_id, (sessionRuns.get(r.session_id) ?? 0) + 1);
			const why = reason(r);
			if (why && !keptSessions.has(r.session_id)) keptSessions.set(r.session_id, why);
		}
		const featureOf = new Map([...features.values()].map((f) => [`${f.project}/${f.slug}`, f]));
		return {
			runs: runs.map((r) => ({
				id: r.id,
				project: r.project,
				purpose: r.purpose,
				status: r.status,
				prompt: r.prompt.slice(0, 120),
				created_at: r.created_at,
				events: r.events,
				bytes: r.event_bytes + (r.host_run_id ? (logBytes.get(r.host_run_id) ?? 0) : 0),
				keep: reason(r),
			})),
			// Logs on disk that no run in the database points to.
			orphanLogs: disk.runLogs.filter((l) => !knownLogs.has(l.id)).map((l) => ({ id: l.id, bytes: l.bytes, modified: l.modified, keep: l.active ? "still active" : null })),
			worktrees: disk.worktrees.map((w) => {
				const f = featureOf.get(`${w.project}/${w.slug}`);
				return { ...w, feature: f ? { id: f.id, title: f.title, status: f.status } : null, keep: f && !CLOSED.has(f.status) ? `feature is ${f.status.replace("_", " ")}` : null };
			}),
			sessions: disk.sessions.map((s) => ({ ...s, runs: sessionRuns.get(s.id) ?? 0, keep: keptSessions.get(s.id) ?? null })),
			log: db.cleanupLog(),
		};
	}

	type Result = { target: string; ok: boolean; bytes?: number; error?: string };

	/** Runs one deletion per target, writes each outcome to the log, and never stops at the first failure. */
	async function each<T>(kind: string, items: T[], label: (item: T) => string, remove: (item: T) => Promise<{ bytes: number; detail?: string }>): Promise<{ results: Result[] }> {
		const results: Result[] = [];
		for (const item of items.slice(0, 500)) {
			const target = label(item);
			try {
				const { bytes, detail } = await remove(item);
				db.logCleanup({ kind, target, bytes, detail });
				results.push({ target, ok: true, bytes });
			} catch (err) {
				const error = (err as Error).message;
				db.logCleanup({ kind, target, detail: `not deleted: ${error}`, ok: false });
				results.push({ target, ok: false, error });
			}
		}
		return { results };
	}

	const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);

	return {
		overview,
		/** Deletes finished runs: their rows, their events and their log on the server. */
		async deleteRuns(ids: unknown) {
			const { runs, reason } = keepReasons();
			const byId = new Map(runs.map((r) => [r.id, r]));
			return each("run", strings(ids), (id) => id, async (id) => {
				const r = byId.get(id);
				if (!r) throw new Error("run not found");
				const why = reason(r);
				if (why) throw new Error(why);
				let bytes = r.event_bytes;
				if (r.host_run_id) bytes += (await host.post<{ bytes: number }>("/cleanup/run-log", { id: r.host_run_id })).bytes;
				db.deleteRun(id);
				return { bytes, detail: `${r.project.startsWith("_") ? "kit library" : r.project}${r.purpose ? `, ${r.purpose}` : ""}, ${r.status}, ${r.events} events: ${r.prompt.slice(0, 80)}` };
			});
		},
		async deleteOrphanLogs(ids: unknown) {
			const known = new Set(db.allRuns().map((r) => r.host_run_id));
			return each("run log", strings(ids), (id) => id, async (id) => {
				if (known.has(id)) throw new Error("this log belongs to a run; delete the run instead");
				return { bytes: (await host.post<{ bytes: number }>("/cleanup/run-log", { id })).bytes, detail: "log without a run" };
			});
		},
		async deleteWorktrees(items: unknown) {
			const list = (Array.isArray(items) ? items : []).filter((i): i is { project: string; slug: string } => typeof i?.project === "string" && typeof i?.slug === "string");
			const featureOf = new Map(db.allFeatures().map((f) => [`${f.project}/${f.slug}`, f]));
			return each("worktree", list, (i) => `${i.project}/${i.slug}`, async (i) => {
				const f = featureOf.get(`${i.project}/${i.slug}`);
				if (f && !CLOSED.has(f.status)) throw new Error(`feature "${f.title}" is ${f.status.replace("_", " ")}; discard or merge it first`);
				const res = await host.post<{ bytes: number }>("/cleanup/worktree", i);
				return { bytes: res.bytes, detail: f ? `feature "${f.title}" (${f.status}); branch kept` : "no feature uses it; branch kept" };
			});
		},
		async deleteSessions(items: unknown) {
			const list = (Array.isArray(items) ? items : []).filter((i): i is { folder: string; id: string } => typeof i?.folder === "string" && typeof i?.id === "string");
			const { runs, reason } = keepReasons();
			return each("session", list, (i) => `${i.folder}/${i.id}`, async (i) => {
				const users = runs.filter((r) => r.session_id === i.id);
				const why = users.map(reason).find(Boolean);
				if (why) throw new Error(`used by a run that must stay (${why})`);
				const res = await host.post<{ bytes: number }>("/cleanup/session", i);
				return { bytes: res.bytes, detail: users.length ? `${users.length} run(s) can no longer be resumed` : "no run uses it" };
			});
		},
	};
}
