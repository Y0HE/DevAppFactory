import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type CreateResult, type Kit, type Project, type Run, type Status, type Team } from "./api";
import { ProjectPage } from "./ProjectPage";
import { RunPage } from "./RunPage";
import { FeaturePage } from "./FeaturePage";
import { KitsPage } from "./KitsPage";
import { TeamsPage } from "./TeamsPage";
import { CleanupPage } from "./CleanupPage";
import { RunsTable } from "./RunsTable";
import { ClaudeAuthDialog } from "./ClaudeAuthDialog";

const CHECKS: { key: keyof Status; label: string }[] = [
	{ key: "host", label: "Host service" },
	{ key: "claude", label: "Claude Code" },
	{ key: "github", label: "GitHub" },
	{ key: "docker", label: "Docker" },
	{ key: "gateway", label: "Gateway" },
];

const NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

function useHash(): string {
	const [hash, setHash] = useState(location.hash);
	useEffect(() => {
		const onChange = () => setHash(location.hash);
		addEventListener("hashchange", onChange);
		return () => removeEventListener("hashchange", onChange);
	}, []);
	return hash;
}

export function App() {
	const hash = useHash();
	const project = hash.match(/^#\/projects\/([a-z0-9-]+)$/);
	const run = hash.match(/^#\/runs\/([0-9a-f-]{36})$/);
	const feature = hash.match(/^#\/features\/(\d+)$/);
	const team = hash.match(/^#\/teams(?:\/([a-z0-9-]+))?$/);
	return (
		<>
			<header className="top">
				<h1>
					<a href="#/">DevAppFactory</a>
				</h1>
				<nav>
					<a href="#/">Projects</a>
					<a href="#/teams">Teams</a>
					<a href="#/kits">Kits</a>
					<a href="#/cleanup">Cleanup</a>
				</nav>
			</header>
			{hash === "#/kits" ? <KitsPage /> : hash === "#/cleanup" ? <CleanupPage /> : team ? <TeamsPage initial={team[1]} /> : project ? <ProjectPage key={project[1]} name={project[1]} /> : feature ? <FeaturePage key={feature[1]} id={Number(feature[1])} /> : run ? <RunPage key={run[1]} id={run[1]} /> : <Dashboard />}
		</>
	);
}

function Dashboard() {
	const [runs, setRuns] = useState<Run[]>([]);
	const [status, setStatus] = useState<Status | null>(null);
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [connecting, setConnecting] = useState(location.hash === "#/connect-claude");

	const refresh = useCallback(() => {
		api.status().then(setStatus).catch((e) => setError(e.message));
		api.projects()
			.then((p) => (setProjects(p), setError(null)))
			.catch((e) => setError(e.message));
		api.runs().then(setRuns).catch(() => {});
	}, []);

	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, 10_000);
		return () => clearInterval(timer);
	}, [refresh]);

	return (
		<>
			<main>
				<section aria-label="System status" className="status">
					{CHECKS.map(({ key, label }) => {
						const check = status?.[key];
						const state = !status ? "unknown" : check?.ok ? "ok" : "bad";
						return (
							<div key={key} className={`check ${state}`}>
								<span className="dot" aria-hidden />
								<div>
									<strong>{label}</strong>
									<small>{!status ? "Checking…" : check?.ok ? (check.user ?? check.version ?? "OK") : (check?.detail ?? "Unavailable")}</small>
									{key === "claude" && status?.host?.ok && (
										<button className="link" onClick={() => setConnecting(true)}>
											{check?.token ? "Manage token" : "Connect Claude"}
										</button>
									)}
								</div>
							</div>
						);
					})}
				</section>

				{error && <p className="error">{error}</p>}
				{connecting && (
					<ClaudeAuthDialog
						token={status?.claude?.token ?? null}
						onClose={() => {
							setConnecting(false);
							if (location.hash === "#/connect-claude") location.hash = "#/";
							refresh();
						}}
					/>
				)}

				<section>
					<div className="section-head">
						<h2>Projects</h2>
						<button className="primary" onClick={() => setCreating(true)} disabled={!status?.host?.ok}>
							New project
						</button>
					</div>
					{projects === null ? (
						<p className="muted">Loading…</p>
					) : projects.length === 0 ? (
						<p className="empty">No projects yet. Create one to get a GitHub repo, a local clone and a kit.</p>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Name</th>
										<th>Phase</th>
										<th>Kit</th>
										<th>Branch</th>
										<th>Last commit</th>
										<th>Folder</th>
									</tr>
								</thead>
								<tbody>
									{projects.map((p) => (
										<tr key={p.id}>
											<td>
												<a href={`#/projects/${p.name}`}>{p.name}</a>
											</td>
											<td>
												<span className="pill">{p.phase}</span>
											</td>
											<td>
												{p.kit}@{p.kit_version}
											</td>
											<td>{p.git?.exists ? <GitSummary git={p.git} /> : <span className="muted">folder missing</span>}</td>
											<td>{p.git?.lastCommit ? `${p.git.lastCommit.sha} ${p.git.lastCommit.subject}` : "–"}</td>
											<td>
												<code>{p.path}</code>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</section>

				<section>
					<h2>Agent runs</h2>
					<RunsTable runs={runs.slice(0, 15)} showProject />
				</section>
			</main>
			{creating && <NewProject onClose={() => setCreating(false)} onCreated={refresh} />}
		</>
	);
}

function GitSummary({ git }: { git: NonNullable<Project["git"]> }) {
	const notes = [
		git.uncommitted ? `${git.uncommitted} uncommitted` : "",
		git.ahead ? `${git.ahead} ahead` : "",
		git.behind ? `${git.behind} behind` : "",
	].filter(Boolean);
	return (
		<>
			{git.branch}
			{notes.length > 0 && <small className="muted"> ({notes.join(", ")})</small>}
		</>
	);
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
	const [kits, setKits] = useState<Kit[]>([]);
	const [name, setName] = useState("");
	const [kit, setKit] = useState("");
	const [visibility, setVisibility] = useState("private");
	const [idea, setIdea] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<CreateResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	// null until the library's teams are known.
	const [teams, setTeams] = useState<Team[] | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());

	useEffect(() => {
		api.kits()
			.then((list) => (setKits(list), setKit((current) => current || list[0]?.name || "")))
			.catch((e) => setError(e.message));
		api.teams()
			.then((t) => setTeams(t.teams))
			.catch((e) => (setTeams([]), setError(e.message)));
	}, []);
	// A project starts with at least one team, as long as the library has any.
	const teamsOk = teams !== null && (teams.length === 0 || chosen.size > 0);

	const nameValid = NAME.test(name);
	const selected = kits.find((k) => k.name === kit);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			const res = await api.createProject({ name, kit, idea, visibility, teams: (teams ?? []).map((t) => t.id).filter((id) => chosen.has(id)) });
			setResult(res);
			if (res.ok) onCreated();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="new-title">
			<form className="dialog" onSubmit={submit}>
				<h2 id="new-title">New project</h2>
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="my-app" autoFocus required disabled={busy || result?.ok} />
					<small className={name && !nameValid ? "bad-text" : "muted"}>Lowercase letters, digits and dashes. Used for the GitHub repo and the folder.</small>
				</label>
				<div className="row">
					<label>
						Kit
						<select value={kit} onChange={(e) => setKit(e.target.value)} disabled={busy || result?.ok}>
							{kits.map((k) => (
								<option key={k.name} value={k.name}>
									{k.name}@{k.version}
								</option>
							))}
						</select>
					</label>
					<label>
						GitHub visibility
						<select value={visibility} onChange={(e) => setVisibility(e.target.value)} disabled={busy || result?.ok}>
							<option value="private">Private</option>
							<option value="public">Public</option>
						</select>
					</label>
				</div>
				{selected?.description && <p className="muted">{selected.description}</p>}
				<fieldset className="pick">
					<legend>Teams</legend>
					{teams === null ? (
						<small className="muted">Loading…</small>
					) : teams.length === 0 ? (
						<small className="muted">
							The library has no teams yet. Put one together on the <a href="#/teams">Teams page</a>; it can be given to this project later on its page.
						</small>
					) : (
						<>
							<ul className="plain">
								{teams.map((t) => (
									<li key={t.id}>
										<label className="toggle">
											<input
												type="checkbox"
												checked={chosen.has(t.id)}
												disabled={busy || result?.ok}
												onChange={(e) => {
													const next = new Set(chosen);
													if (e.target.checked) next.add(t.id);
													else next.delete(t.id);
													setChosen(next);
												}}
											/>
											<span>
												{t.id}
												<small className="muted">
													{" "}
													· {(t.components.agents ?? []).join(", ")}
													{t.description ? ` · ${t.description}` : ""}
												</small>
											</span>
										</label>
									</li>
								))}
							</ul>
							<small className={chosen.size === 0 ? "bad-text" : "muted"}>Choose one or more. Their subagents, rules, skills, commands, hooks and MCP servers are part of the project's first commit. Teams can be added, updated or removed later on the project page.</small>
						</>
					)}
				</fieldset>
				<label>
					Idea
					<textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={5} placeholder="What should this app do, and for whom?" disabled={busy || result?.ok} />
				</label>

				{result && (
					<ul className="steps">
						{result.steps.map((s, i) => (
							<li key={i} className={s.ok ? "ok" : "bad"}>
								<strong>{s.step}</strong> {s.detail}
							</li>
						))}
					</ul>
				)}
				{error && <p className="error">{error}</p>}

				<div className="actions">
					<button type="button" onClick={onClose} disabled={busy}>
						{result?.ok ? "Close" : "Cancel"}
					</button>
					{!result?.ok && (
						<button className="primary" type="submit" disabled={busy || !nameValid || !kit || !teamsOk}>
							{busy ? "Creating…" : "Create project"}
						</button>
					)}
				</div>
			</form>
		</div>
	);
}
