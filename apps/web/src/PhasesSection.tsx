import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type PhaseOverview, type PhaseRun } from "./api";

const PHASES = ["spec", "plan", "build", "release", "operate"];
const LABEL: Record<string, string> = { spec: "Specification", plan: "Plan", build: "Build", release: "Release", operate: "Operate" };
const NEXT: Record<string, string> = {
	spec: "Have an agent write the specification from the idea, then approve it.",
	plan: "Review the architecture and the proposed features, then approve the plan.",
	build: "Planned features are built one after another. Review and merge each one.",
	release: "All planned features are merged. Check preview, then promote it to production.",
	operate: "The app is live. Add features and fixes as needed.",
};

function Conversation({
	title,
	run,
	canStart,
	startLabel,
	onSend,
	onApprove,
	approveLabel,
	canApprove,
	approved,
	models,
	children,
}: {
	title: string;
	run: PhaseRun | null;
	canStart: boolean;
	startLabel: string;
	onSend: (text: string, model?: string) => Promise<void>;
	onApprove: () => Promise<void>;
	approveLabel: string;
	canApprove: boolean;
	approved: boolean;
	models: { value: string; label: string }[];
	children: React.ReactNode;
}) {
	const [text, setText] = useState("");
	const [model, setModel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function act(fn: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await fn();
			setText("");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	}
	const submit = (e: FormEvent) => (e.preventDefault(), void act(() => onSend(text, model || undefined)));

	return (
		<div className="card">
			<div className="run-head">
				<strong>{title}</strong>
				{approved && <span className="pill ok">approved</span>}
				{run?.active && <span className="pill live">agent working</span>}
				{run && (
					<a href={`#/runs/${run.id}`} className="push-right">
						{run.active ? "Watch live" : "Transcript"}
					</a>
				)}
			</div>
			{children}
			{run && !run.active && run.message && (
				<div className="line assistant">
					<small className="muted">Agent</small>
					<p>{run.message}</p>
				</div>
			)}
			{run && ["failed", "auth_required", "paused_limit", "interrupted"].includes(run.status) && <p className="error">The last agent run ended as {run.status.replace("_", " ")}. Reply to continue.</p>}
			{error && <p className="error">{error}</p>}
			{!run ? (
				canStart && (
					<form onSubmit={submit} className="stack">
						<label>
							Anything the agent should know first (optional)
							<textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={busy} />
						</label>
						<div className="actions spread">
							<select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} aria-label="Model">
								{models.map((m) => (
									<option key={m.value} value={m.value}>
										{m.label}
									</option>
								))}
							</select>
							<button className="primary" type="submit" disabled={busy}>
								{busy ? "Starting…" : startLabel}
							</button>
						</div>
					</form>
				)
			) : (
				!run.active &&
				!approved && (
					<form onSubmit={submit} className="stack">
						<label>
							Reply to the agent
							<textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Answer its questions, or say what to change." disabled={busy} />
						</label>
						<div className="actions">
							<button type="submit" disabled={busy || !text.trim()}>
								Send
							</button>
							<button type="button" className="primary" disabled={busy || !canApprove} onClick={() => act(onApprove)}>
								{approveLabel}
							</button>
						</div>
					</form>
				)
			)}
		</div>
	);
}

export function PhasesSection({ name, models }: { name: string; models: { value: string; label: string }[] }) {
	const [data, setData] = useState<PhaseOverview | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(
		() =>
			api.phases(name)
				.then((d) => (setData(d), setError(null)))
				.catch((e) => setError(e.message)),
		[name],
	);
	const working = data?.spec.run?.active || data?.plan.run?.active || false;
	useEffect(() => {
		void refresh();
		const timer = setInterval(refresh, working ? 3_000 : 15_000);
		return () => clearInterval(timer);
	}, [refresh, working]);

	if (!data) return error ? <p className="error">{error}</p> : null;
	const at = PHASES.indexOf(data.phase);
	const specApproved = at > 0;
	const planApproved = at > 1;
	const { spec, plan } = data;

	return (
		<section>
			<ol className="steps-bar">
				{PHASES.map((p, i) => (
					<li key={p} className={i < at ? "done" : i === at ? "current" : ""}>
						{LABEL[p]}
					</li>
				))}
			</ol>
			<p className="muted">{NEXT[data.phase]}</p>

			{(data.phase === "spec" || spec.content || spec.run) && (
				<Conversation
					title="Specification"
					run={spec.run}
					canStart={!specApproved}
					startLabel="Write the specification"
					approveLabel="Approve specification"
					canApprove={Boolean(spec.content)}
					approved={specApproved}
					models={models}
					onSend={(text, model) => api.phaseMessage(name, "spec", text, model).then(() => void refresh())}
					onApprove={() => api.phaseApprove(name, "spec").then(() => void refresh())}
				>
					{spec.content ? (
						<details open={!specApproved}>
							<summary>
								<code>docs/spec.md</code>
							</summary>
							<pre className="output doc">{spec.content}</pre>
						</details>
					) : (
						!spec.run && <p className="muted">No specification yet. The agent reads the idea in docs/idea.md and asks you questions if it needs to.</p>
					)}
				</Conversation>
			)}

			{(specApproved || plan.run) && (plan.run || plan.items || data.phase === "plan") && (
				<div className="gap-above">
					<Conversation
						title="Plan"
						run={plan.run}
						canStart={!planApproved}
						startLabel="Write the plan"
						approveLabel="Approve plan and start building"
						canApprove={Boolean(plan.items) && plan.errors.length === 0}
						approved={planApproved}
						models={models}
						onSend={(text, model) => api.phaseMessage(name, "plan", text, model).then(() => void refresh())}
						onApprove={() => api.phaseApprove(name, "plan").then(() => void refresh())}
					>
						{plan.architecture && (
							<details>
								<summary>
									<code>docs/architecture.md</code>
								</summary>
								<pre className="output doc">{plan.architecture}</pre>
							</details>
						)}
						{plan.items && (
							<details open={!planApproved}>
								<summary>Proposed features ({plan.items.length})</summary>
								<ol className="plan-list">
									{plan.items.map((item) => (
										<li key={item.title}>
											<strong>{item.title}</strong>
											{item.depends_on.length > 0 && <small className="muted"> · after {item.depends_on.join(", ")}</small>}
											<p>{item.description}</p>
										</li>
									))}
								</ol>
							</details>
						)}
						{plan.errors.map((e) => (
							<p key={e} className="error">
								{e}
							</p>
						))}
					</Conversation>
				</div>
			)}

			{at >= 2 && (
				<label className="toggle gap-above">
					<input type="checkbox" checked={data.autoBuild} onChange={(e) => api.setAutoBuild(name, e.target.checked).then(() => void refresh())} />
					<span>
						Start planned features automatically
						<small className="muted"> · one at a time, in dependency order; you still review and merge each one</small>
					</span>
				</label>
			)}
		</section>
	);
}
