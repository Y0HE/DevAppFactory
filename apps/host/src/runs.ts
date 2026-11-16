// Keeps track of agent runs started by this service and lets clients follow their events.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { parse } from "yaml";
import { config } from "./config.js";
import { mcpServers } from "./kits.js";
import { projectPath } from "./projects.js";
import { startRun, type Run, type RunEvent, type RunResult } from "./runner.js";

/** Chatter that is not useful in a transcript. */
const SKIP_SYSTEM = new Set(["commands_changed", "thinking_tokens"]);

/** Denied whatever the project allows. */
const DENY = ["Bash(git push*)", "Bash(sudo *)"];
export const KITS_PROJECT = "_kits";
const COMMAND = /^[a-z0-9][a-z0-9 ._-]{0,40}$/i;

/**
 * Commands the agent may run without asking, from the kit record in the project.
 * They are passed on the command line because Claude Code ignores allow rules in a
 * project's own settings file until someone has accepted its trust dialog there.
 */
function allowlist(cwd: string): string[] {
	let commands: unknown = ["git"];
	try {
		const meta = parse(readFileSync(join(cwd, ".factory", "project.yml"), "utf8"));
		if (Array.isArray(meta?.allowed_commands)) commands = meta.allowed_commands;
	} catch {}
	return (commands as unknown[]).filter((c): c is string => typeof c === "string" && COMMAND.test(c)).map((c) => `Bash(${c} *)`);
}

interface Entry {
	run: Run;
	project: string;
	events: RunEvent[];
	bus: EventEmitter;
	result?: RunResult;
	rateLimit?: { status: string; resetsAt?: number; type?: string };
	log: string;
}

const runs = new Map<string, Entry>();

export interface StartRequest {
	project: string;
	prompt: string;
	model?: string;
	resumeSessionId?: string;
	/** Run in this feature's worktree instead of the project folder. */
	feature?: string;
	/** Lead the run with this subagent of the project. */
	agent?: string;
}

export function start(req: StartRequest) {
	if (typeof req.prompt !== "string" || !req.prompt.trim()) throw new Error("prompt is required");
	if (req.model !== undefined && !/^[a-z0-9.-]{1,60}$/i.test(req.model)) throw new Error("invalid model");
	if (req.resumeSessionId !== undefined && !/^[0-9a-f-]{36}$/.test(req.resumeSessionId)) throw new Error("invalid session id");
	if (req.feature !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(req.feature)) throw new Error("invalid feature");
	// "_kits" is the kit library itself: an agent there may edit files but run no commands.
	const library = req.project === KITS_PROJECT;
	const cwd = library ? config.kitsDir : req.feature ? join(config.worktreesDir, req.project, req.feature) : projectPath(req.project);
	if (!existsSync(cwd)) throw new Error(`folder not found: ${cwd}`);

	if (req.agent !== undefined && (library || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(req.agent) || !existsSync(join(cwd, ".claude", "agents", `${req.agent}.md`)))) throw new Error(`this project has no subagent named ${req.agent}`);

	// The project's MCP servers are installed by the factory, so their tools are allowed like its commands.
	const servers = library ? [] : mcpServers(cwd);
	const allow = library ? [] : [...allowlist(cwd), ...servers.map((id) => `mcp__${id}`)];
	const run = startRun({
		cwd,
		prompt: req.prompt,
		model: req.model,
		agent: req.agent,
		mcpConfig: servers.length ? join(cwd, ".mcp.json") : undefined,
		resumeSessionId: req.resumeSessionId,
		policy: { allow, deny: library ? [...DENY, "Bash(git *)"] : DENY },
	});
	const dir = join(config.home, "runs", run.id);
	mkdirSync(dir, { recursive: true });
	const entry: Entry = { run, project: req.project, events: [], bus: new EventEmitter(), log: join(dir, "events.jsonl") };
	entry.bus.setMaxListeners(0);
	runs.set(run.id, entry);

	const push = (event: RunEvent) => {
		entry.events.push(event);
		appendFileSync(entry.log, JSON.stringify(event) + "\n");
		entry.bus.emit("event", event);
	};
	let seq = 0;
	run.on("event", (e: RunEvent) => {
		const p = e.payload as any;
		if (e.type === "system" && SKIP_SYSTEM.has(p?.subtype)) return;
		if (e.type === "rate_limit_event") {
			const info = p?.rate_limit_info ?? {};
			entry.rateLimit = { status: info.status, resetsAt: info.resetsAt, type: info.rateLimitType };
			if (info.status === "allowed") return; // only surface it when it matters
		}
		push({ ...e, seq: seq++ });
	});
	void run.done.then((result) => {
		// A rejected limit status is more reliable than matching the error text.
		if (result.status === "failed" && entry.rateLimit && entry.rateLimit.status === "rejected") result.status = "paused_limit";
		entry.result = result;
		push({ seq: seq++, at: new Date().toISOString(), type: "run_end", payload: { ...result, rateLimit: entry.rateLimit } });
		entry.bus.emit("end");
		setTimeout(() => runs.delete(run.id), 60 * 60 * 1000).unref(); // the log file stays on disk
	});

	return { id: run.id, sessionId: run.sessionId, project: req.project };
}

function get(id: string): Entry {
	const entry = runs.get(id);
	if (!entry) throw new Error("run not found");
	return entry;
}

export function info(id: string) {
	const e = get(id);
	return { id, project: e.project, sessionId: e.run.sessionId, status: e.result?.status ?? "running", result: e.result, events: e.events.length, rateLimit: e.rateLimit };
}

/** True while the agent of this run has not finished. */
export function active(id: string): boolean {
	const entry = runs.get(id);
	return !!entry && !entry.result;
}

export function known(id: string): boolean {
	return runs.has(id);
}

export function message(id: string, text: string) {
	const e = get(id);
	if (e.result) throw new Error("run has already ended");
	if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
	e.run.send(text);
	return { ok: true };
}

export function interrupt(id: string) {
	const e = get(id);
	if (!e.result) e.run.interrupt();
	return { ok: true };
}

/** Calls `write` for every event after `after`, past and future; resolves when the run has ended. */
export function follow(id: string, after: number, write: (event: RunEvent) => void, onClose: (stop: () => void) => void): Promise<void> {
	const e = get(id);
	return new Promise((resolve) => {
		for (const event of e.events) if (event.seq > after) write(event);
		if (e.result) return resolve();
		const stop = () => {
			e.bus.off("event", write);
			e.bus.off("end", stop);
			resolve();
		};
		e.bus.on("event", write);
		e.bus.on("end", stop);
		onClose(stop);
	});
}
