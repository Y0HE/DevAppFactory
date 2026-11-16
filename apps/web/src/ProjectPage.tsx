import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ACTIVE, api, type ProjectDetail, type ProjectTeams } from "./api";
import { RunsTable, StatusPill } from "./RunsTable";
import { ChecksSection, DevelopSection, FeaturesSection, GitSection } from "./ProjectSections";
import { DeploymentsSection } from "./DeploymentsSection";
import { PhasesSection } from "./PhasesSection";

const MODELS = [
	{ value: "", label: "Default model" },
	{ value: "haiku", label: "Haiku (fastest, lowest usage)" },
	{ value: "sonnet", label: "Sonnet" },
	{ value: "opus", label: "Opus" },
];

export function ProjectPage({ name }: { name: string }) {
	const [project, setProject] = useState<ProjectDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [agent, setAgent] = useState("");
	const [agents, setAgents] = useState<{ id: string; lead: boolean }[]>([]);
	const [teams, setTeams] = useState<ProjectTeams["teams"] | null>(null);
	useEffect(() => {
		// Polled, so a team assigned or removed further down the page shows up in the summary.
		const load = () =>
			api.projectTeams(name)
				.then((t) => (setTeams(t.teams), setAgents(t.agents.map((id) => ({ id, lead: t.teams.some((x) => x.lead === id) })))))
				.catch(() => {});
		void load();
		const timer = setInterval(load, 10_000);
		return () => clearInterval(timer);
	}, [name]);
	const [busy, setBusy] = useState(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [creating, setCreating] = useState(false);
	const [sshTarget, setSshTarget] = useState<string | undefined>();
	useEffect(() => void api.status().then((s) => setSshTarget(s.host?.sshTarget)).catch(() => {}), []);

	const refresh = useCallback(() => {
		api.project(name)
			.then((p) => (setProject(p), setError(null)))
			.catch((e) => setError(e.message));
	}, [name]);

	const anyActive = (project?.runs.some((r) => ACTIVE.has(r.status)) || project?.features.some((f) => ["building", "checking"].includes(f.status))) ?? false;
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, anyActive ? 3_000 : 15_000);
		return () => clearInterval(timer);
	}, [refresh, anyActive]);

	async function start(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			const run = await api.startRun(name, { prompt, model: model || undefined, agent: agent || undefined });
			location.hash = `#/runs/${run.id}`;
		} catch (err) {
			setError((err as Error).message);
			setBusy(false);
		}
	}

	async function createFeature(e: FormEvent) {
		e.preventDefault();
		setCreating(true);
		setError(null);
		try {
			const feature = await api.createFeature(name, { title, description, model: model || undefined });
			location.hash = `#/features/${feature.id}`;
		} catch (err) {
			setError((err as Error).message);
			setCreating(false);
		}
	}

	if (!project) return <main>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;
	const git = project.git;

	return (
		<main>
			<section>
				<p className="crumbs">
					<a href="#/">Projects</a> / {project.name}
				</p>
				<div className="facts">
					<div>
						<small>Phase</small>
						<span className="pill">{project.phase}</span>
					</div>
					<div>
						<small>Kit</small>
						{project.kit}@{project.kit_version}
					</div>
					<div>
						<small>GitHub</small>
						<a href={project.url} target="_blank" rel="noreferrer">
							{project.repo}
						</a>
					</div>
					<div>
						<small>Branch</small>
						{git?.exists ? (
							<>
								{git.branch}
								{git.uncommitted ? <span className="muted"> · {git.uncommitted} uncommitted</span> : null}
								{git.ahead ? <span className="muted"> · {git.ahead} ahead</span> : null}
							</>
						) : (
							<span className="bad-text">folder missing</span>
						)}
					</div>
					<div className="wide">
						<small>{teams?.length === 1 ? "Team" : "Teams"}</small>
						{teams === null ? (
							<span className="muted">…</span>
						) : teams.length === 0 ? (
							<span className="muted">None. Assign one under AI features.</span>
						) : (
							teams.map((t, i) => (
								<span key={t.id}>
									{i > 0 && ", "}
									{t.id}@{t.version}
									{t.updateAvailable && <span className="bad-text"> (version {t.latest} available)</span>}
								</span>
							))
						)}
					</div>
					<div className="wide">
						<small>Folder on the server</small>
						<code>{project.path}</code>
					</div>
					{git?.lastCommit && (
						<div className="wide">
							<small>Last commit</small>
							<code>{git.lastCommit.sha}</code> {git.lastCommit.subject}
						</div>
					)}
				</div>
			</section>

			{error && <p className="error">{error}</p>}

			<PhasesSection name={name} models={MODELS} />

			<DevelopSection name={name} path={project.path} sshTarget={sshTarget} />
			<ChecksSection name={name} />

			<section>
				<h2>Features</h2>
				{project.features.length > 0 && (
					<div className="table-wrap gap-below">
						<table>
							<thead>
								<tr>
									<th>Status</th>
									<th>Feature</th>
									<th>Pull request</th>
									<th>Updated</th>
								</tr>
							</thead>
							<tbody>
								{project.features.map((f) => (
									<tr key={f.id}>
										<td>
											<StatusPill status={f.status} />
										</td>
										<td>
											<a href={`#/features/${f.id}`}>{f.title}</a>
											{f.status === "planned" && JSON.parse(f.depends_on).length > 0 && <small className="muted"> · after {JSON.parse(f.depends_on).join(", ")}</small>}
										</td>
										<td>
											{f.pr_url ? (
												<a href={f.pr_url} target="_blank" rel="noreferrer">
													#{f.pr_number}
												</a>
											) : (
												"–"
											)}
										</td>
										<td>{new Date(f.updated_at).toLocaleString()}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<form className="card" onSubmit={createFeature}>
					<label>
						New feature
						<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title, e.g. Add a contact page" required disabled={creating} />
					</label>
					<label>
						What it should do
						<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe the behaviour and how you will know it is done." required disabled={creating} />
					</label>
					<div className="actions spread">
						<select value={model} onChange={(e) => setModel(e.target.value)} disabled={creating} aria-label="Model">
							{MODELS.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
						<button className="primary" type="submit" disabled={creating || !title.trim() || !description.trim() || !git?.exists}>
							{creating ? "Creating…" : "Build feature"}
						</button>
					</div>
					<small className="muted">The agent builds it on its own branch and folder. Checks run afterwards, then you review the diff before a pull request is opened.</small>
				</form>
			</section>

			<section>
				<h2>Start an agent in the main folder</h2>
				<form className="card" onSubmit={start}>
					<label>
						Task
						<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Describe what the agent should do in this project." required disabled={busy} />
					</label>
					<div className="actions spread">
						<select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} aria-label="Model">
							{MODELS.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
						{agents.length > 0 && (
							<select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={busy} aria-label="Lead the run with">
								<option value="">No lead: general agent</option>
								{agents.map((a) => (
									<option key={a.id} value={a.id}>
										Led by {a.id}
										{a.lead ? " (team lead)" : ""}
									</option>
								))}
							</select>
						)}
						<button className="primary" type="submit" disabled={busy || !prompt.trim() || !git?.exists}>
							{busy ? "Starting…" : "Start agent"}
						</button>
					</div>
					<small className="muted">For one-off tasks outside the feature pipeline. The agent works directly in the project folder. It can edit files and commit; it cannot push, and commands outside the kit's allowlist are denied.</small>
				</form>
			</section>

			<section>
				<h2>Agent runs</h2>
				<RunsTable runs={project.runs} />
			</section>

			<DeploymentsSection name={name} />
			<GitSection name={name} poll={anyActive} />
			<FeaturesSection name={name} />
		</main>
	);
}
