// Drives one headless Claude Code session and turns its output into run events.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { claudeAuthEnv } from "./claudeauth.js";

export interface PermissionPolicy {
	/** Claude Code permission rules that are allowed without asking, e.g. "Bash(docker compose *)". */
	allow: string[];
	/** Rules that are always denied, e.g. "Bash(git push *)". */
	deny: string[];
}

export interface RunOptions {
	cwd: string;
	prompt: string;
	policy: PermissionPolicy;
	model?: string;
	/** Run the session as this subagent from the project's `.claude/agents`. */
	agent?: string;
	/** MCP configuration file of the project, when it has one. */
	mcpConfig?: string;
	/** Continue an earlier Claude session instead of starting a new one. */
	resumeSessionId?: string;
	claudeBin?: string;
}

export type RunStatus = "running" | "succeeded" | "failed" | "interrupted" | "auth_required" | "paused_limit";

export interface RunEvent {
	seq: number;
	at: string;
	/** Raw stream-json message from Claude Code, or a runner-level event. */
	type: string;
	payload: unknown;
}

export interface RunResult {
	status: RunStatus;
	sessionId?: string;
	exitCode: number | null;
	text?: string;
	usage?: { inputTokens: number; outputTokens: number };
	numTurns?: number;
}

const GUARD = fileURLToPath(new URL("../hooks/guard.mjs", import.meta.url));

/** Only these variables reach the agent; anything else on the service's environment is dropped. */
const ENV_PASSTHROUGH = ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "DOCKER_HOST"];

export function buildArgs(opts: RunOptions, sessionId: string): string[] {
	const settings = {
		hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${JSON.stringify(GUARD)}` }] }] },
	};
	const args = [
		"--print",
		"--verbose",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--replay-user-messages", // echoes each stdin message when Claude Code takes it up
		"--permission-mode", "acceptEdits",
		"--permission-prompts", "none", // anything that would prompt is denied
		"--settings", JSON.stringify(settings),
	];
	if (opts.policy.allow.length) args.push("--allowedTools", ...opts.policy.allow);
	if (opts.policy.deny.length) args.push("--disallowedTools", ...opts.policy.deny);
	// Only the project's own MCP servers: nothing from the server user's account or plugins.
	args.push("--strict-mcp-config");
	if (opts.mcpConfig) args.push("--mcp-config", opts.mcpConfig);
	if (opts.model) args.push("--model", opts.model);
	if (opts.agent) args.push("--agent", opts.agent);
	if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
	else args.push("--session-id", sessionId);
	return args;
}

export function buildEnv(opts: RunOptions, runId: string, source: NodeJS.ProcessEnv = process.env, auth: Record<string, string> = claudeAuthEnv()): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_PASSTHROUGH) if (source[key] !== undefined) env[key] = source[key];
	// The long-lived token saved from the UI, when there is one; otherwise ~/.claude credentials.
	Object.assign(env, auth);
	env.FACTORY_RUN_ID = runId;
	env.FACTORY_WORKDIR = opts.cwd;
	return env;
}

/** Maps Claude Code's final `result` message (plus exit state) to a run status. */
export function classifyResult(result: any, interrupted: boolean): RunStatus {
	if (interrupted) return "interrupted";
	if (!result) return "failed";
	const text = typeof result.result === "string" ? result.result : "";
	if (result.terminal_reason === "api_error" || result.is_error) {
		// Two processes refreshing the shared login at once: transient, the credentials are fine.
		if (/another Claude Code process is refreshing/i.test(text)) return "failed";
		if (/authenticat|OAuth|log ?in|401/i.test(text)) return "auth_required";
		// TODO(verify): exact shape of a subscription limit result has not been observed yet.
		if (/usage limit|rate limit|limit reached|429/i.test(text)) return "paused_limit";
		return "failed";
	}
	return result.subtype === "success" ? "succeeded" : "failed";
}

export class Run extends EventEmitter {
	readonly id = randomUUID();
	readonly sessionId: string;
	readonly done: Promise<RunResult>;
	status: RunStatus = "running";

	private child: ChildProcessWithoutNullStreams;
	private seq = 0;
	private interrupted = false;
	/** User messages written to stdin that Claude Code has not echoed back yet. */
	private unacked = 0;
	private lastResult: any;

	constructor(private opts: RunOptions) {
		super();
		this.sessionId = opts.resumeSessionId ?? randomUUID();
		this.child = spawn(opts.claudeBin ?? "claude", buildArgs(opts, this.sessionId), {
			cwd: opts.cwd,
			env: buildEnv(opts, this.id),
			stdio: ["pipe", "pipe", "pipe"],
		});

		createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
		createInterface({ input: this.child.stderr }).on("line", (line) => this.record("stderr", line));

		this.done = new Promise((resolve) => {
			this.child.on("error", (err) => {
				this.record("runner_error", String(err));
				this.finish(resolve, null);
			});
			this.child.on("close", (code) => this.finish(resolve, code));
		});

		// Do not leave an agent running if the service goes away.
		const killOnExit = () => this.child.exitCode === null && this.child.kill("SIGTERM");
		process.once("exit", killOnExit);
		this.child.once("close", () => process.off("exit", killOnExit));

		this.writeUser(opts.prompt);
	}

	/**
	 * Send another user message. Claude Code folds it into the running turn when it
	 * arrives mid-turn, or starts a new turn when the previous one has finished.
	 */
	send(text: string): void {
		this.writeUser(text);
	}

	/**
	 * Stop the current run. Asks Claude Code to interrupt over the control channel,
	 * then falls back to signals if the process does not exit.
	 * TODO(verify): the control_request message shape against a live session.
	 */
	interrupt(graceMs = 5000): void {
		if (this.child.exitCode !== null) return;
		this.interrupted = true;
		this.writeLine({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
		this.child.stdin.end();
		setTimeout(() => this.child.exitCode === null && this.child.kill("SIGINT"), graceMs).unref();
		setTimeout(() => this.child.exitCode === null && this.child.kill("SIGKILL"), graceMs * 2).unref();
	}

	private writeUser(text: string): void {
		this.unacked++;
		this.writeLine({ type: "user", message: { role: "user", content: text } });
	}

	private writeLine(obj: unknown): void {
		if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + "\n");
	}

	private onLine(line: string): void {
		if (!line.trim()) return;
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			this.record("stdout", line);
			return;
		}
		if (msg.type === "user" && msg.isReplay) {
			this.unacked = Math.max(0, this.unacked - 1);
			this.record("user_ack", msg);
			return;
		}
		this.record(msg.type ?? "unknown", msg);
		if (msg.type === "result") {
			this.lastResult = msg;
			// With streaming input the process stays alive until stdin closes.
			// Close it only when every message we sent has been taken up.
			if (this.unacked === 0) this.child.stdin.end();
		}
	}

	private record(type: string, payload: unknown): void {
		const event: RunEvent = { seq: this.seq++, at: new Date().toISOString(), type, payload };
		this.emit("event", event);
	}

	private finish(resolve: (r: RunResult) => void, exitCode: number | null): void {
		const r = this.lastResult;
		this.status = classifyResult(r, this.interrupted);
		if (this.status === "succeeded" && exitCode !== 0) this.status = "failed";
		resolve({
			status: this.status,
			sessionId: r?.session_id ?? this.sessionId,
			exitCode,
			text: typeof r?.result === "string" ? r.result : undefined,
			usage: r?.usage && { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0 },
			numTurns: r?.num_turns,
		});
	}
}

export function startRun(opts: RunOptions): Run {
	return new Run(opts);
}
