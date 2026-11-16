import { useEffect, useRef, useState, type FormEvent } from "react";
import { ACTIVE, api, type Run, type RunEvent } from "./api";
import { duration, StatusPill } from "./RunsTable";

interface Line {
	key: string;
	kind: "user" | "assistant" | "tool" | "result" | "denied" | "note" | "error";
	title?: string;
	text: string;
	failed?: boolean;
}

function clip(text: string, max = 4000): string {
	return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more characters)` : text;
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n");
	return JSON.stringify(content);
}

function toolInput(name: string, input: any): string {
	if (name === "Bash") return input?.command ?? "";
	if (input?.file_path) return input.file_path;
	if (input?.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ""}`;
	return JSON.stringify(input);
}

/** Turns raw Claude Code events into transcript lines. */
function toLines(e: RunEvent): Line[] {
	const p = e.payload ?? {};
	const key = (i: number) => `${e.seq}-${i}`;
	switch (e.type) {
		case "user_ack":
			return [{ key: key(0), kind: "user", text: typeof p.message?.content === "string" ? p.message.content : toolResultText(p.message?.content) }];
		case "assistant":
			return (p.message?.content ?? []).flatMap((c: any, i: number): Line[] => {
				if (c.type === "text" && c.text.trim()) return [{ key: key(i), kind: "assistant", text: c.text }];
				if (c.type === "tool_use") return [{ key: key(i), kind: "tool", title: c.name, text: toolInput(c.name, c.input) }];
				return [];
			});
		case "user":
			return (Array.isArray(p.message?.content) ? p.message.content : []).flatMap((c: any, i: number): Line[] =>
				c.type === "tool_result" ? [{ key: key(i), kind: c.is_error ? "denied" : "result", text: clip(toolResultText(c.content)), failed: c.is_error }] : c.type === "text" ? [{ key: key(i), kind: "note", text: c.text }] : [],
			);
		case "factory_started":
			return [{ key: key(0), kind: "note", text: p.resumed ? "Agent started, continuing the earlier session." : "Agent started." }];
		case "factory_cancelled":
			return [{ key: key(0), kind: "note", text: "Cancelled before it started." }];
		case "factory_error":
		case "runner_error":
			return [{ key: key(0), kind: "error", text: p.message ?? String(p) }];
		case "stderr":
			return [{ key: key(0), kind: "error", text: String(p) }];
		case "rate_limit_event":
			return [{ key: key(0), kind: "error", text: `Usage limit: ${p.rate_limit_info?.status}${p.rate_limit_info?.resetsAt ? `, resets ${new Date(p.rate_limit_info.resetsAt * 1000).toLocaleString()}` : ""}` }];
		default:
			return [];
	}
}

export function RunPage({ id }: { id: string }) {
	const [run, setRun] = useState<Run | null>(null);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const bottom = useRef<HTMLDivElement>(null);
	const stick = useRef(true);

	useEffect(() => {
		api.run(id).then(setRun).catch((e) => setError(e.message));
		const source = new EventSource(`/api/runs/${id}/events`);
		source.onmessage = (m) => {
			const event = JSON.parse(m.data) as RunEvent;
			setEvents((list) => (list.some((x) => x.seq === event.seq) ? list : [...list, event]));
		};
		source.addEventListener("status", (m) => setRun(JSON.parse((m as MessageEvent).data)));
		return () => source.close();
	}, [id]);

	// Refresh the header (duration, status) while the run is active.
	const active = run ? ACTIVE.has(run.status) : false;
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => api.run(id).then(setRun).catch(() => {}), 2_000);
		return () => clearInterval(timer);
	}, [id, active]);

	useEffect(() => {
		const onScroll = () => (stick.current = innerHeight + scrollY >= document.body.scrollHeight - 80);
		addEventListener("scroll", onScroll);
		return () => removeEventListener("scroll", onScroll);
	}, []);
	useEffect(() => {
		if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
	}, [events.length]);

	async function act(fn: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!run || !text.trim()) return;
		if (run.status === "running") {
			void act(() => api.sendMessage(id, text).then(() => setText("")));
		} else {
			const start = run.project.startsWith("_")
				? fetch("/api/kitlib/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: text, model: run.model ?? undefined, resumeRunId: id }) }).then((r) => r.json())
				: api.startRun(run.project, { prompt: text, model: run.model ?? undefined, resumeRunId: id });
			void act(() => start.then((next) => (location.hash = `#/runs/${next.id}`)));
		}
	}

	if (!run) return <main>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;
	const lines = events.flatMap(toLines);
	const canResume = !active && Boolean(run.session_id);

	return (
		<main>
			<section>
				<p className="crumbs">
					{run.project.startsWith("_") ? <a href="#/kits">Kits</a> : <><a href="#/">Projects</a> / <a href={`#/projects/${run.project}`}>{run.project}</a></>} / run
				</p>
				<div className="run-head">
					<StatusPill status={run.status} />
					<span className="muted">
						{duration(run)}
						{run.model ? ` · ${run.model}` : ""}
						{run.agent ? ` · led by ${run.agent}` : ""}
						{run.tokens_out ? ` · ${run.tokens_out} tokens out` : ""}
					</span>
					{active && (
						<button onClick={() => act(() => api.interrupt(id))} disabled={busy}>
							Stop
						</button>
					)}
				</div>
				{run.status === "auth_required" && <p className="error">Claude Code is not logged in on the server. Run `claude auth login` there, then resume.</p>}
				{run.status === "paused_limit" && (
					<p className="error">Usage limit reached{run.resets_at ? `; it resets ${new Date(run.resets_at * 1000).toLocaleString()}` : ""}. Resume the run after that.</p>
				)}
			</section>

			<section className="transcript" aria-live="polite">
				{lines.length === 0 && <p className="muted">{run.status === "queued" ? "Waiting for a free agent slot…" : "No output yet."}</p>}
				{lines.map((l) => (
					<div key={l.key} className={`line ${l.kind}`}>
						{l.kind === "tool" ? (
							<>
								<strong>{l.title}</strong> <code>{l.text}</code>
							</>
						) : l.kind === "result" || l.kind === "denied" ? (
							<pre>{l.text}</pre>
						) : (
							<p>{l.text}</p>
						)}
					</div>
				))}
				<div ref={bottom} />
			</section>

			{error && <p className="error">{error}</p>}

			{(run.status === "running" || canResume) && (
				<form className="card" onSubmit={submit}>
					<label>
						{run.status === "running" ? "Message to the agent" : "Continue this session"}
						<textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={run.status === "running" ? "Add an instruction; the agent picks it up at its next step." : "What should the agent do next?"} disabled={busy} />
					</label>
					<div className="actions">
						<button className="primary" type="submit" disabled={busy || !text.trim()}>
							{run.status === "running" ? "Send" : "Resume"}
						</button>
					</div>
				</form>
			)}
		</main>
	);
}
