// Run orchestration: queue with a concurrency cap, event storage, live fan-out to browsers.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Db, EventRow, RunRow } from "./db.js";
import type { HostClient } from "./host.js";

const ACTIVE = ["running"];
const FINAL = new Set(["succeeded", "failed", "interrupted", "auth_required", "paused_limit"]);

export function runService(db: Db, host: HostClient, maxConcurrent: number) {
	const bus = new EventEmitter();
	bus.setMaxListeners(0);

	function emit(runId: string, event: EventRow) {
		db.insertEvent(runId, event);
		bus.emit(runId, event);
	}

	/** Records something the factory itself did, in the same stream as the agent's events. */
	function note(runId: string, type: string, payload: unknown) {
		emit(runId, { seq: db.lastSeq(runId) + 1, at: new Date().toISOString(), type, payload });
	}

	const endListeners: ((run: RunRow) => void)[] = [];

	function finish(runId: string, status: string, extra: Partial<RunRow> = {}) {
		db.updateRun(runId, { status, ended_at: new Date().toISOString(), ...extra });
		bus.emit(`${runId}:end`);
		const run = db.getRun(runId);
		if (run) for (const listener of endListeners) listener(run);
		void pump();
	}

	/** Follows a run on the host until it ends, storing every event. */
	async function follow(run: RunRow, hostRunId: string, offset: number, after: number) {
		try {
			await host.stream(`/runs/${hostRunId}/events?after=${after}`, (e) => {
				if (e.type === "run_end") {
					const r = e.payload ?? {};
					emit(run.id, { ...e, seq: e.seq + offset });
					finish(run.id, FINAL.has(r.status) ? r.status : "failed", {
						session_id: r.sessionId ?? run.session_id,
						result_text: r.text ?? null,
						tokens_in: r.usage?.inputTokens ?? 0,
						tokens_out: r.usage?.outputTokens ?? 0,
						resets_at: r.rateLimit?.resetsAt ?? null,
					});
				} else {
					emit(run.id, { ...e, seq: e.seq + offset });
				}
			});
		} catch (err) {
			note(run.id, "factory_error", { message: `Lost the connection to factory-host: ${(err as Error).message}` });
		}
		// The stream closed without a final event: the host went away mid-run.
		if (db.getRun(run.id)?.status === "running") finish(run.id, "failed");
	}

	async function launch(run: RunRow) {
		const resumed = run.resume_of ? db.getRun(run.resume_of) : undefined;
		const feature = run.feature_id ? db.getFeature(run.feature_id) : undefined;
		try {
			const started = await host.post<{ id: string; sessionId: string }>("/runs", {
				project: run.project,
				prompt: run.prompt,
				model: run.model ?? undefined,
				resumeSessionId: resumed?.session_id ?? undefined,
				feature: feature?.slug,
			});
			db.updateRun(run.id, { status: "running", host_run_id: started.id, session_id: started.sessionId, started_at: new Date().toISOString() });
			note(run.id, "factory_started", { hostRunId: started.id, resumed: Boolean(resumed) });
			void follow(run, started.id, db.lastSeq(run.id) + 1, -1);
		} catch (err) {
			note(run.id, "factory_error", { message: (err as Error).message });
			finish(run.id, "failed");
		}
	}

	let pumping = false;
	async function pump() {
		if (pumping) return;
		pumping = true;
		try {
			for (;;) {
				const free = maxConcurrent - db.runsByStatus(...ACTIVE).length;
				const next = db.runsByStatus("queued")[0];
				if (free <= 0 || !next) break;
				db.updateRun(next.id, { status: "running" }); // claim the slot before the async call
				await launch(next);
			}
		} finally {
			pumping = false;
		}
	}

	return {
		bus,
		/** Called whenever a run reaches a final status. */
		onEnd(listener: (run: RunRow) => void) {
			endListeners.push(listener);
		},
		create(project: string, body: { prompt?: string; model?: string | null; resumeRunId?: string; featureId?: number; purpose?: string; agent?: string }) {
			const row = db.getProject(project);
			if (!row) throw new Error("project not found");
			const prompt = (body.prompt ?? "").trim();
			if (!prompt) throw new Error("prompt is required");
			let resumeOf: string | null = null;
			let agent = body.agent?.trim() || null;
			if (agent && !/^[a-z0-9][a-z0-9-]{0,48}$/.test(agent)) throw new Error("invalid subagent name");
			if (body.resumeRunId) {
				const prev = db.getRun(body.resumeRunId);
				if (!prev || prev.project_id !== row.id) throw new Error("run to resume not found in this project");
				if (!FINAL.has(prev.status)) throw new Error("that run is still active");
				if (!prev.session_id) throw new Error("that run has no Claude session to resume");
				resumeOf = prev.id;
				agent ??= prev.agent; // a resumed conversation keeps its lead
			}
			const id = randomUUID();
			db.insertRun({ id, project_id: row.id, prompt, model: body.model?.trim() || null, status: "queued", session_id: null, resume_of: resumeOf, feature_id: body.featureId ?? null, purpose: body.purpose ?? null, agent });
			void pump();
			return db.getRun(id)!;
		},
		async message(id: string, text: string) {
			const run = db.getRun(id);
			if (!run || run.status !== "running" || !run.host_run_id) throw new Error("run is not running");
			await host.post(`/runs/${run.host_run_id}/message`, { text });
			return { ok: true };
		},
		async interrupt(id: string) {
			const run = db.getRun(id);
			if (!run) throw new Error("run not found");
			if (run.status === "queued") {
				note(id, "factory_cancelled", {});
				finish(id, "interrupted");
			} else if (run.status === "running" && run.host_run_id) {
				await host.post(`/runs/${run.host_run_id}/interrupt`, {});
			}
			return { ok: true };
		},
		/** After a restart of this service: runs that were active can no longer be followed. */
		recover() {
			for (const run of db.runsByStatus("running")) {
				// Stop the agent if it is still going: nothing is following it any more.
				if (run.host_run_id) void host.post(`/runs/${run.host_run_id}/interrupt`, {}).catch(() => {});
				note(run.id, "factory_error", { message: "The factory restarted while this run was active, so the agent was stopped. Resume it to continue." });
				db.updateRun(run.id, { status: "failed", ended_at: new Date().toISOString() });
			}
			void pump();
		},
	};
}
