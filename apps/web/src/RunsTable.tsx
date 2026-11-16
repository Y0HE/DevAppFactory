import type { Run } from "./api";

export function StatusPill({ status }: { status: string }) {
	const tone = ["succeeded", "merged", "live"].includes(status)
		? "ok"
		: ["running", "queued", "building", "checking", "review", "pr_open", "deploying"].includes(status)
			? "live"
			: ["interrupted", "cancelled", "planned"].includes(status)
				? ""
				: "bad";
	return <span className={`pill ${tone}`}>{status === "pr_open" ? "pull request open" : status.replace("_", " ")}</span>;
}

export function duration(run: Run): string {
	if (!run.started_at) return "–";
	const ms = (run.ended_at ? Date.parse(run.ended_at) : Date.now()) - Date.parse(run.started_at);
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function RunsTable({ runs, showProject = false }: { runs: Run[]; showProject?: boolean }) {
	if (runs.length === 0) return <p className="empty">No agent runs yet.</p>;
	return (
		<div className="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Status</th>
						{showProject && <th>Project</th>}
						<th>Task</th>
						<th>Started</th>
						<th>Duration</th>
						<th>Tokens out</th>
					</tr>
				</thead>
				<tbody>
					{runs.map((r) => (
						<tr key={r.id}>
							<td>
								<StatusPill status={r.status} />
							</td>
							{showProject && (
								<td>
									{r.project.startsWith("_") ? <a href="#/kits">kit library</a> : <a href={`#/projects/${r.project}`}>{r.project}</a>}
								</td>
							)}
							<td>
								<a href={`#/runs/${r.id}`}>{r.prompt.length > 90 ? r.prompt.slice(0, 90) + "…" : r.prompt}</a>
								{r.resume_of && <small className="muted"> (resumed)</small>}
							</td>
							<td>{new Date(r.created_at).toLocaleString()}</td>
							<td>{duration(r)}</td>
							<td>{r.tokens_out || "–"}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
