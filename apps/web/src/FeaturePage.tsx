import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type FeatureDetail } from "./api";
import { RunsTable, StatusPill } from "./RunsTable";

const STEPS = ["building", "checking", "review", "pr_open", "merged"];
const STEP_LABEL: Record<string, string> = { building: "Build", checking: "Checks", review: "Review", pr_open: "Pull request", merged: "Merged" };

function Diff({ text }: { text: string }) {
	// One block per file, so long diffs stay navigable.
	const files = text.split(/^(?=diff --git )/m).filter(Boolean);
	return (
		<>
			{files.map((file, i) => {
				const name = file.match(/^diff --git a\/(.+?) b\//)?.[1] ?? `file ${i + 1}`;
				const body = file.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/.test(l));
				return (
					<details key={name + i} open={files.length <= 12} className="diff-file">
						<summary>{name}</summary>
						<pre>
							{body.map((line, n) => (
								<span key={n} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : undefined}>
									{line + "\n"}
								</span>
							))}
						</pre>
					</details>
				);
			})}
		</>
	);
}

export function FeaturePage({ id }: { id: number }) {
	const [f, setF] = useState<FeatureDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [info, setInfo] = useState<string | null>(null);

	const refresh = useCallback(() => {
		api.feature(id)
			.then((d) => (setF(d), setError((e) => (busy ? e : null))))
			.catch((e) => setError(e.message));
	}, [id, busy]);

	const moving = f ? ["building", "checking"].includes(f.status) : true;
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, moving ? 3_000 : 15_000);
		return () => clearInterval(timer);
	}, [refresh, moving]);

	async function act(name: string, fn: () => Promise<unknown>, done?: string) {
		setBusy(name);
		setError(null);
		setInfo(null);
		try {
			await fn();
			if (done) setInfo(done);
			setF(await api.feature(id));
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	}

	function sendChanges(e: FormEvent) {
		e.preventDefault();
		void act("changes", () => api.requestChanges(id, text).then(() => setText("")));
	}

	if (!f) return <main>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;

	const wt = f.worktree;
	const stepIndex = STEPS.indexOf(f.status);
	const canInstruct = ["review", "pr_open", "needs_attention"].includes(f.status);
	const closed = ["merged", "cancelled"].includes(f.status);
	const activeRun = f.runs.find((r) => r.status === "running" || r.status === "queued");
	const prBlocked = f.pr && (f.pr.mergeable === "CONFLICTING" || f.pr.checks.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes((c.conclusion || c.status).toUpperCase())));
	const prPending = f.pr?.checks.some((c) => !c.conclusion && !["SUCCESS", "FAILURE", "ERROR"].includes(c.status.toUpperCase()));

	return (
		<main>
			<section>
				<p className="crumbs">
					<a href="#/">Projects</a> / <a href={`#/projects/${f.project}`}>{f.project}</a> / feature
				</p>
				<div className="run-head">
					<h2 className="inline">{f.title}</h2>
					<StatusPill status={f.status} />
				</div>
				{stepIndex >= 0 && (
					<ol className="steps-bar">
						{STEPS.map((s, i) => (
							<li key={s} className={i < stepIndex ? "done" : i === stepIndex ? "current" : ""}>
								{STEP_LABEL[s]}
							</li>
						))}
					</ol>
				)}
				<p className="pre-wrap">{f.description}</p>
				{f.status === "planned" && (
					<p className="muted">
						Planned{JSON.parse(f.depends_on).length ? `; it starts after: ${JSON.parse(f.depends_on).join(", ")}` : ""}. It starts by itself when its turn comes, or you can start it now.
					</p>
				)}
				{f.note && <p className={f.status === "needs_attention" ? "error" : "muted"}>{f.note}</p>}
				{info && <p className="muted">{info}</p>}
				{error && <p className="error">{error}</p>}
				{activeRun && (
					<p>
						The agent is working. <a href={`#/runs/${activeRun.id}`}>Watch the live transcript</a>
					</p>
				)}
			</section>

			{!closed && (
				<section className="card">
					<div className="button-row start">
						{f.status === "planned" && (
							<button className="primary" disabled={!!busy} onClick={() => act("start", () => api.startFeature(id))}>
								{busy === "start" ? "Starting…" : "Start now"}
							</button>
						)}
						{f.status === "review" && (
							<button className="primary" disabled={!!busy} onClick={() => act("approve", () => api.featureAction(id, "approve"))}>
								{busy === "approve" ? "Opening pull request…" : f.pr_number ? "Approve and update pull request" : "Approve and open pull request"}
							</button>
						)}
						{f.status === "pr_open" && (
							<button className="primary" disabled={!!busy || !!prBlocked} onClick={() => act("merge", () => api.featureAction(id, "merge"))}>
								{busy === "merge" ? "Merging…" : "Merge pull request"}
							</button>
						)}
						{["review", "needs_attention"].includes(f.status) && wt.exists && (
							<button disabled={!!busy} onClick={() => act("recheck", () => api.featureAction(id, "recheck"))}>
								{busy === "recheck" ? "Running checks…" : "Re-run checks"}
							</button>
						)}
						{wt.exists && !moving && (
							<button disabled={!!busy} onClick={() => act("preview", () => api.featureAction(id, "preview"), "The dev URL now serves this feature. Start the dev environment from the project page to switch back.")}>
								{busy === "preview" ? "Starting…" : "Preview on dev URL"}
							</button>
						)}
						<button
							disabled={!!busy}
							onClick={() => {
								if (confirm("Discard this feature? Its branch, folder and open pull request are deleted. This cannot be undone.")) void act("discard", () => api.featureAction(id, "discard"));
							}}
						>
							{busy === "discard" ? "Discarding…" : "Discard"}
						</button>
					</div>
					{f.status === "pr_open" && prBlocked && <p className="error">The pull request has a conflict or a failed check, so it cannot be merged yet.</p>}
					{f.status === "pr_open" && !prBlocked && prPending && <p className="muted">CI checks are still running. You can wait for them or merge now.</p>}
					{canInstruct && (
						<form onSubmit={sendChanges} className="stack">
							<label>
								{f.status === "needs_attention" ? "Tell the agent how to continue" : "Request changes"}
								<textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="The agent continues its session with this instruction, then checks run again." disabled={!!busy} />
							</label>
							<div className="actions">
								<button type="submit" disabled={!!busy || !text.trim()}>
									{busy === "changes" ? "Sending…" : "Send to agent"}
								</button>
							</div>
						</form>
					)}
				</section>
			)}

			{f.pr?.exists && (
				<section>
					<h2>Pull request</h2>
					<div className="card">
						<div className="run-head">
							<a href={f.pr.url} target="_blank" rel="noreferrer">
								#{f.pr.number}
							</a>
							<span className="pill">{f.pr.state.toLowerCase()}</span>
							{f.pr.state === "OPEN" && <span className={`pill ${f.pr.mergeable === "CONFLICTING" ? "bad" : ""}`}>{f.pr.mergeable === "MERGEABLE" ? "no conflicts" : f.pr.mergeable.toLowerCase()}</span>}
						</div>
						{f.pr.checks.length === 0 ? (
							<p className="muted">No CI checks are configured for this repository.</p>
						) : (
							<ul className="plain">
								{f.pr.checks.map((c) => (
									<li key={c.name}>
										<span className={`pill ${c.conclusion === "SUCCESS" ? "ok" : c.conclusion ? "bad" : "live"}`}>{(c.conclusion || c.status).toLowerCase()}</span> {c.url ? <a href={c.url}>{c.name}</a> : c.name}
									</li>
								))}
							</ul>
						)}
					</div>
				</section>
			)}

			<section>
				<h2>Checks{f.round > 0 ? ` (round ${f.round})` : ""}</h2>
				{f.checks.length === 0 ? (
					<p className="empty">{f.round === 0 ? "Checks run after the agent finishes." : "This project defines no checks."}</p>
				) : (
					<div className="card">
						{f.checks.map((c) => (
							<div key={c.id} className="check-row">
								<div className="run-head">
									<span className={`pill ${c.ok ? "ok" : "bad"}`}>{c.ok ? "passed" : `failed (exit ${c.code})`}</span>
									<strong>{c.name}</strong>
									<code>{c.command}</code>
									<span className="muted">{(c.duration_ms / 1000).toFixed(1)}s</span>
								</div>
								{c.output && <pre className="output">{c.output}</pre>}
							</div>
						))}
					</div>
				)}
			</section>

			{wt.exists && (
				<section>
					<h2>Changes</h2>
					<p className="muted">
						Branch <code>{wt.branch}</code> compared with <code>{wt.base}</code>: {wt.commits!.length} commit(s), {wt.files!.length} file(s)
						{wt.uncommitted ? `, ${wt.uncommitted} uncommitted change(s)` : ""}. Folder: <code>{wt.dir}</code>
					</p>
					<ul className="plain mono">
						{wt.files!.map((file) => (
							<li key={file.path}>
								<span className="add">+{file.added}</span> <span className="del">-{file.removed}</span> {file.path}
							</li>
						))}
					</ul>
					{wt.diff ? <Diff text={wt.diff} /> : <p className="empty">No changes yet.</p>}
					{wt.diffTruncated && <p className="muted">The diff is too large to show in full.</p>}
				</section>
			)}

			<section>
				<h2>Agent runs</h2>
				<RunsTable runs={[...f.runs].reverse()} />
			</section>
		</main>
	);
}
