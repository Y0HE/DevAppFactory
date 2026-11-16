import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type CleanupOverview, type CleanupResult } from "./api";
import { StatusPill } from "./RunsTable";

export function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const when = (iso: string) => new Date(iso).toLocaleString();
const daysOld = (iso: string) => (Date.now() - Date.parse(iso)) / 86_400_000;

interface Row {
	key: string;
	bytes: number;
	date: string;
	keep: string | null;
	cells: ReactNode[];
}

/** One kind of thing that can be deleted: a table with a checkbox per row that may go. */
function Group(props: { title: string; intro: string; empty: string; columns: string[]; rows: Row[]; busy: boolean; confirmText: (n: number) => string; onDelete: (keys: string[]) => void }) {
	const { rows } = props;
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const free = rows.filter((r) => !r.keep);
	// Drop ticks for rows that are gone or have become needed.
	const freeKeys = free.map((r) => r.key).join("|");
	useEffect(() => setPicked((old) => new Set([...old].filter((k) => free.some((r) => r.key === k)))), [freeKeys]);
	const pickedBytes = rows.filter((r) => picked.has(r.key)).reduce((sum, r) => sum + r.bytes, 0);
	const set = (keys: string[]) => setPicked(new Set(keys));

	return (
		<section>
			<h2>
				{props.title} ({rows.length}, {size(rows.reduce((sum, r) => sum + r.bytes, 0))})
			</h2>
			<p className="muted">{props.intro}</p>
			{rows.length === 0 ? (
				<p className="empty">{props.empty}</p>
			) : (
				<div className="card">
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>
										<span className="sr-only">Select</span>
									</th>
									{props.columns.map((c) => (
										<th key={c}>{c}</th>
									))}
									<th>Size</th>
									<th>Can it go?</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<tr key={r.key}>
										<td>
											<input
												type="checkbox"
												aria-label={`Select ${r.key}`}
												checked={picked.has(r.key)}
												disabled={props.busy || r.keep !== null}
												onChange={(e) => {
													const next = new Set(picked);
													if (e.target.checked) next.add(r.key);
													else next.delete(r.key);
													setPicked(next);
												}}
											/>
										</td>
										{r.cells.map((cell, i) => (
											<td key={i}>{cell}</td>
										))}
										<td>{size(r.bytes)}</td>
										<td>{r.keep ? <small className="muted">Kept: {r.keep}</small> : <small>Yes</small>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div className="actions spread">
						<span className="button-row start">
							<button disabled={props.busy || free.length === 0} onClick={() => set(free.map((r) => r.key))}>
								Select all that can go ({free.length})
							</button>
							<button disabled={props.busy || free.length === 0} onClick={() => set(free.filter((r) => daysOld(r.date) > 7).map((r) => r.key))}>
								Older than 7 days
							</button>
							<button disabled={props.busy || picked.size === 0} onClick={() => set([])}>
								Select none
							</button>
						</span>
						<button
							className="primary"
							disabled={props.busy || picked.size === 0}
							onClick={() => {
								if (confirm(props.confirmText(picked.size))) props.onDelete([...picked]);
							}}
						>
							Delete {picked.size} ({size(pickedBytes)})
						</button>
					</div>
				</div>
			)}
		</section>
	);
}

export function CleanupPage() {
	const [data, setData] = useState<CleanupOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [last, setLast] = useState<CleanupResult["results"] | null>(null);

	const refresh = useCallback(() => api.cleanup.overview().then(setData).catch((e) => setError(e.message)), []);
	useEffect(() => {
		void refresh();
		const timer = setInterval(refresh, 30_000);
		return () => clearInterval(timer);
	}, [refresh]);

	async function remove(fn: () => Promise<CleanupResult>) {
		setBusy(true);
		setError(null);
		try {
			setLast((await fn()).results);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			await refresh();
			setBusy(false);
		}
	}

	const project = (name: string) => (name.startsWith("_") ? <a href="#/kits">kit library</a> : <a href={`#/projects/${name}`}>{name}</a>);
	const failed = last?.filter((r) => !r.ok) ?? [];

	return (
		<main>
			<section>
				<h2>Cleanup</h2>
				<p className="muted">
					What agent runs leave behind in the factory folder on the server: run records and logs, feature worktrees and Claude Code sessions. Anything still needed is kept and cannot be ticked. Deleting cannot be undone, and every deletion is written to the log at the bottom of this page.
				</p>
				{error && <p className="error">{error}</p>}
				{last && (
					<p className={failed.length ? "error" : "muted"}>
						Deleted {last.length - failed.length} of {last.length}
						{last.length - failed.length > 0 ? `, freeing ${size(last.filter((r) => r.ok).reduce((sum, r) => sum + (r.bytes ?? 0), 0))}` : ""}.{failed.length > 0 && ` Not deleted: ${failed.map((r) => `${r.target} (${r.error})`).join("; ")}`}
					</p>
				)}
				{!data && !error && <p className="muted">Loading…</p>}
			</section>

			{data && (
				<>
					<Group
						title="Agent runs"
						intro="Each run keeps its transcript in the database and a raw log on the server. Deleting a run removes both, and it disappears from every run list. Runs of open features and the latest spec and plan conversations are kept, because the factory resumes them."
						empty="No agent runs."
						columns={["Status", "Project", "Task", "Started", "Events"]}
						rows={data.runs.map((r) => ({
							key: r.id,
							bytes: r.bytes,
							date: r.created_at,
							keep: r.keep,
							cells: [
								<StatusPill status={r.status} />,
								project(r.project),
								<>
									<a href={`#/runs/${r.id}`}>{r.prompt.length > 70 ? r.prompt.slice(0, 70) + "…" : r.prompt}</a>
									{r.purpose && <small className="muted"> ({r.purpose})</small>}
								</>,
								when(r.created_at),
								r.events,
							],
						}))}
						busy={busy}
						confirmText={(n) => `Delete ${n} agent ${n === 1 ? "run" : "runs"} with ${n === 1 ? "its" : "their"} transcript and log? This cannot be undone.`}
						onDelete={(keys) => remove(() => api.cleanup.runs(keys))}
					/>

					{data.orphanLogs.length > 0 && (
						<Group
							title="Run logs without a run"
							intro="Raw logs on the server that no run in the database points to, for example from tests of the runner."
							empty=""
							columns={["Log", "Last written"]}
							rows={data.orphanLogs.map((l) => ({ key: l.id, bytes: l.bytes, date: l.modified, keep: l.keep, cells: [<code>{l.id}</code>, when(l.modified)] }))}
							busy={busy}
							confirmText={(n) => `Delete ${n} run ${n === 1 ? "log" : "logs"}? This cannot be undone.`}
							onDelete={(keys) => remove(() => api.cleanup.runLogs(keys))}
						/>
					)}

					<Group
						title="Worktrees"
						intro="The folder each feature is built in. The factory removes it when a feature is merged or discarded; one listed here as free was left behind. Deleting removes the folder and any uncommitted files in it. The local branch is kept."
						empty="No worktrees on the server."
						columns={["Project", "Worktree", "Feature", "Branch", "Last changed"]}
						rows={data.worktrees.map((w) => ({
							key: `${w.project}/${w.slug}`,
							bytes: w.bytes,
							date: w.modified,
							keep: w.keep,
							cells: [
								project(w.project),
								<>
									<code>{w.slug}</code>
									{w.uncommitted > 0 && <small className="bad-text"> · {w.uncommitted} uncommitted</small>}
								</>,
								w.feature ? (
									<>
										<a href={`#/features/${w.feature.id}`}>{w.feature.title}</a> <StatusPill status={w.feature.status} />
									</>
								) : (
									<small className="muted">none</small>
								),
								w.branch ?? "–",
								when(w.modified),
							],
						}))}
						busy={busy}
						confirmText={(n) => `Delete ${n} ${n === 1 ? "worktree" : "worktrees"}, including any uncommitted files? This cannot be undone.`}
						onDelete={(keys) => remove(() => api.cleanup.worktrees(keys.map((k) => ({ project: k.split("/")[0], slug: k.split("/")[1] }))))}
					/>

					<Group
						title="Claude sessions"
						intro="Claude Code's own record of each conversation held in a factory folder, by the factory or by you in a terminal. A run can only be resumed while its session exists. Sessions of runs that must stay are kept."
						empty="No Claude sessions for factory folders."
						columns={["Folder", "Session", "Used by", "Last written"]}
						rows={data.sessions.map((s) => ({
							key: `${s.folder}/${s.id}`,
							bytes: s.bytes,
							date: s.modified,
							keep: s.keep,
							cells: [s.where, <code>{s.id.slice(0, 8)}</code>, s.runs ? `${s.runs} ${s.runs === 1 ? "run" : "runs"}` : <small className="muted">no run (started by hand, or its runs were deleted)</small>, when(s.modified)],
						}))}
						busy={busy}
						confirmText={(n) => `Delete ${n} Claude ${n === 1 ? "session" : "sessions"}? Runs that used them can no longer be resumed. This cannot be undone.`}
						onDelete={(keys) => remove(() => api.cleanup.sessions(keys.map((k) => ({ folder: k.split("/")[0], id: k.split("/")[1] }))))}
					/>

					<section>
						<h2>Cleanup log</h2>
						{data.log.length === 0 ? (
							<p className="empty">Nothing has been deleted yet.</p>
						) : (
							<div className="table-wrap">
								<table>
									<thead>
										<tr>
											<th>When</th>
											<th>What</th>
											<th>Target</th>
											<th>Detail</th>
											<th>Freed</th>
										</tr>
									</thead>
									<tbody>
										{data.log.map((l) => (
											<tr key={l.id}>
												<td>{when(l.at)}</td>
												<td>{l.kind}</td>
												<td>
													<code>{l.target.length > 60 ? "…" + l.target.slice(-58) : l.target}</code>
												</td>
												<td className={l.ok ? "" : "bad-text"}>{l.detail}</td>
												<td>{l.ok ? size(l.bytes) : "–"}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						{data.log.length >= 200 && <small className="muted">Showing the latest 200 entries.</small>}
					</section>
				</>
			)}
		</main>
	);
}
