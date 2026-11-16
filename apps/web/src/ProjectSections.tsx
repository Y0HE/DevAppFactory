import { useCallback, useEffect, useState } from "react";
import { api, type CheckResult, type DevStatus, type FeatureGroup, type GitDetail, type KitStatus, type ProjectTeams, type TeamsOverview } from "./api";

function useLoad<T>(load: () => Promise<T>, everyMs?: number) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(() => {
		load()
			.then((d) => (setData(d), setError(null)))
			.catch((e) => setError(e.message));
	}, [load]);
	useEffect(() => {
		refresh();
		if (!everyMs) return;
		const timer = setInterval(refresh, everyMs);
		return () => clearInterval(timer);
	}, [refresh, everyMs]);
	return { data, setData, error, setError, refresh };
}

export function DevelopSection({ name, path, sshTarget }: { name: string; path: string; sshTarget?: string }) {
	const { data: dev, setData, error, setError } = useLoad<DevStatus>(useCallback(() => api.dev(name), [name]), 10_000);
	const [busy, setBusy] = useState<string | null>(null);
	const [output, setOutput] = useState<string | null>(null);
	const [notes, setNotes] = useState<string[]>([]);

	async function act(action: "up" | "stop" | "restart") {
		setBusy(action);
		setError(null);
		setNotes([]);
		try {
			const res = await api.devAction(name, action);
			setData(res.status);
			setNotes(res.notes);
			setOutput(res.ok ? null : res.output);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	}
	async function logs() {
		setBusy("logs");
		try {
			setOutput((await api.devLogs(name)).logs || "(no log output)");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	}

	const running = dev?.state === "running" || dev?.state === "partial";
	return (
		<section>
			<h2>Develop</h2>
			<div className="card">
				<div className="run-head">
					<span className={`pill ${running ? "ok" : dev?.state === "error" ? "bad" : ""}`}>{dev ? (dev.state === "none" ? "no compose file" : dev.state) : "checking…"}</span>
					{dev?.servingFeature && <span className="pill live">serving feature {dev.servingFeature}</span>}
					{dev?.published && running ? (
						<a href={dev.url} target="_blank" rel="noreferrer">
							{dev.url}
						</a>
					) : (
						<span className="muted">{dev?.url}</span>
					)}
					<span className="button-row">
						<button onClick={() => act("up")} disabled={!!busy || !dev?.hasCompose} className={running ? "" : "primary"}>
							{busy === "up" ? "Starting…" : running ? "Rebuild" : "Start"}
						</button>
						<button onClick={() => act("restart")} disabled={!!busy || !running}>
							Restart
						</button>
						<button onClick={() => act("stop")} disabled={!!busy || !running}>
							Stop
						</button>
						<button onClick={logs} disabled={!!busy || !dev?.hasCompose}>
							Logs
						</button>
					</span>
				</div>
				{dev && dev.services.length > 0 && (
					<ul className="plain">
						{dev.services.map((s) => (
							<li key={s.service}>
								<strong>{s.service}</strong> <span className="muted">{s.status}</span>
							</li>
						))}
					</ul>
				)}
				{dev && running && !dev.onEdge && (
					<p className="error">
						No service is on the <code>{dev.edgeNetwork}</code> network, so the dev URL cannot reach the app. This project's docker-compose.yml predates the dev environment; add the network to its web service.
					</p>
				)}
				{notes.map((n) => (
					<p key={n} className="muted">
						{n}
					</p>
				))}
				{(error || dev?.detail) && <p className="error">{error ?? dev?.detail}</p>}
				{output !== null && <pre className="output">{output}</pre>}
				<div className="facts flat">
					<div className="wide">
						<small>Work on it yourself</small>
						<code>cd {path} && claude</code>
					</div>
					{sshTarget && (
						<div className="wide">
							<small>Editor</small>
							<a href={`vscode://vscode-remote/ssh-remote+${sshTarget}${path}`}>Open in VS Code</a> <span className="muted">(remote SSH as {sshTarget})</span>
						</div>
					)}
				</div>
			</div>
		</section>
	);
}

export function ChecksSection({ name }: { name: string }) {
	const { data: checks, error } = useLoad(useCallback(() => api.checks(name), [name]));
	const [results, setResults] = useState<Record<string, CheckResult | "running" | { error: string }>>({});

	async function runOne(id: string) {
		setResults((r) => ({ ...r, [id]: "running" }));
		try {
			const res = await api.runCheck(name, id);
			setResults((r) => ({ ...r, [id]: res }));
		} catch (err) {
			setResults((r) => ({ ...r, [id]: { error: (err as Error).message } }));
		}
	}

	return (
		<section>
			<h2>Checks</h2>
			{error && <p className="error">{error}</p>}
			{checks && checks.length === 0 && <p className="empty">This project's kit defines no checks yet.</p>}
			{checks && checks.length > 0 && (
				<div className="card">
					{checks.map((c) => {
						const r = results[c.id];
						return (
							<div key={c.id} className="check-row">
								<div className="run-head">
									<button onClick={() => runOne(c.id)} disabled={r === "running"}>
										{r === "running" ? "Running…" : `Run ${c.id}`}
									</button>
									<code>{c.command}</code>
									{r && r !== "running" && "ok" in r && <span className={`pill ${r.ok ? "ok" : "bad"}`}>{r.ok ? "passed" : `failed (exit ${r.code})`} · {(r.durationMs / 1000).toFixed(1)}s</span>}
								</div>
								{r && r !== "running" && "error" in r && <p className="error">{r.error}</p>}
								{r && r !== "running" && "ok" in r && r.output && <pre className="output">{r.output}</pre>}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

export function GitSection({ name, poll }: { name: string; poll: boolean }) {
	const { data: git, error } = useLoad<GitDetail>(useCallback(() => api.gitDetail(name), [name]), poll ? 4_000 : 20_000);
	if (error) return <p className="error">{error}</p>;
	if (!git?.exists) return null;
	return (
		<section>
			<h2>Git</h2>
			<div className="card">
				<div>
					<strong>Uncommitted changes</strong>
					{git.changes!.length === 0 ? (
						<p className="muted">Working tree is clean.</p>
					) : (
						<ul className="plain mono">
							{git.changes!.map((c) => (
								<li key={c.path}>
									<span className="code-tag">{c.code}</span> {c.path}
								</li>
							))}
						</ul>
					)}
				</div>
				<div>
					<strong>Branches</strong>
					<ul className="plain">
						{git.branches!.map((b) => (
							<li key={b.name}>
								{b.name === git.branch ? <strong>{b.name}</strong> : b.name} <code>{b.sha}</code> <span className="muted">{b.subject}</span>
							</li>
						))}
					</ul>
				</div>
				<div>
					<strong>Recent commits</strong>
					{git.ahead ? <span className="muted"> · {git.ahead} not pushed</span> : null}
					<ul className="plain">
						{git.commits!.map((c) => (
							<li key={c.sha}>
								<code>{c.sha}</code> {c.subject} <span className="muted">· {c.author}, {new Date(c.at).toLocaleString()}</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</section>
	);
}

export function FeaturesSection({ name }: { name: string }) {
	const { data: groups, setData, error, setError } = useLoad<FeatureGroup[]>(useCallback(() => api.features(name), [name]));
	const { data: kit, refresh: refreshKit } = useLoad<KitStatus>(useCallback(() => api.kitStatus(name), [name]));
	const { data: mine, setData: setMine } = useLoad<ProjectTeams>(useCallback(() => api.projectTeams(name), [name]));
	const { data: allTeams } = useLoad<TeamsOverview>(useCallback(() => api.teams(), []));
	const [addTeam, setAddTeam] = useState("");
	const available = (allTeams?.teams ?? []).filter((t) => !mine?.teams.some((m) => m.id === t.id));

	async function team(id: string, assign: boolean) {
		if (!assign && !confirm(`Remove team ${id} from this project? Its subagents and other parts are deleted here, unless another team or switch still asks for them.`)) return;
		setBusy(`team/${id}`);
		setError(null);
		setInfo(null);
		try {
			const res = await api.setProjectTeam(name, id, assign);
			setMine(res);
			setData(await api.features(name));
			setAddTeam("");
			setInfo(res.committed ? (res.pushed ? "Committed and pushed." : "Committed. Not pushed, because the project folder is not in step with GitHub.") : "Nothing to commit.");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	}
	const [busy, setBusy] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const drift = kit?.components.filter((c) => c.state !== "same") ?? [];

	async function run(id: string, fn: () => Promise<unknown>, done?: string) {
		setBusy(id);
		setError(null);
		setInfo(null);
		try {
			await fn();
			if (done) setInfo(done);
			refreshKit();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function toggle(kind: string, id: string, enabled: boolean) {
		setBusy(`${kind}/${id}`);
		setError(null);
		try {
			setData((await api.setFeature(name, kind, id, enabled)).features);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	}

	return (
		<section>
			<h2>AI features</h2>
			{error && <p className="error">{error}</p>}
			{info && <p className="muted">{info}</p>}
			{kit && (
				<div className="card gap-below">
					<div className="run-head">
						<span>
							Kit <strong>{kit.kit}</strong> version {kit.version}
						</span>
						{kit.updateAvailable ? <span className="pill live">version {kit.latest} available</span> : <span className="pill ok">up to date</span>}
						{kit.updateAvailable && (
							<button className="primary push-right" disabled={busy !== null} onClick={() => run("upgrade", () => api.upgradeKit(name).then((f) => (location.hash = `#/features/${f.id}`)))}>
								{busy === "upgrade" ? "Preparing…" : "Upgrade (opens a feature to review)"}
							</button>
						)}
					</div>
					{drift.length > 0 && (
						<>
							<strong>Differs from the library</strong>
							<ul className="plain">
								{drift.map((c) => (
									<li key={`${c.kind}/${c.id}`} className="var-row">
										<span>
											{c.kind} / <code>{c.id}</code> <span className="muted">· {c.state === "project-only" ? "only in this project" : "changed in this project or in the library"}</span>
										</span>
										<button
											disabled={busy !== null}
											onClick={() => run(`${c.kind}/${c.id}`, () => api.promote(name, c.kind, c.id), `Copied ${c.kind}/${c.id} into the library. Review and commit it on the Kits page.`)}
										>
											Promote to library
										</button>
									</li>
								))}
							</ul>
						</>
					)}
				</div>
			)}
			{mine && (
				<div className="card gap-below">
					<strong>Teams</strong>
					{mine.teams.length === 0 ? (
						<p className="muted">No team is assigned to this project.</p>
					) : (
						<ul className="plain">
							{mine.teams.map((t) => (
								<li key={t.id} className="var-row">
									<span>
										<strong>{t.id}</strong> version {t.version}
										<span className="muted">
											{" "}
											· {(t.components.agents ?? []).join(", ") || "no members"}
											{t.lead ? ` · lead: ${t.lead}` : ""}
										</span>{" "}
										{t.latest === null ? <span className="pill bad">no longer in the library</span> : t.updateAvailable ? <span className="pill live">version {t.latest} available</span> : <span className="pill ok">up to date</span>}
									</span>
									<span className="button-row">
										{t.updateAvailable && (
											<button className="primary" disabled={busy !== null} onClick={() => team(t.id, true)}>
												Update
											</button>
										)}
										<button disabled={busy !== null} onClick={() => team(t.id, false)}>
											Remove
										</button>
									</span>
								</li>
							))}
						</ul>
					)}
					{available.length > 0 && (
						<div className="var-form">
							<select value={addTeam} onChange={(e) => setAddTeam(e.target.value)} aria-label="Team to assign" disabled={busy !== null}>
								<option value="">Choose a team…</option>
								{available.map((t) => (
									<option key={t.id} value={t.id}>
										{t.id} (version {t.version}, {t.components.agents?.length ?? 0} members)
									</option>
								))}
							</select>
							<button disabled={busy !== null || !addTeam} onClick={() => team(addTeam, true)}>
								Assign team
							</button>
						</div>
					)}
					<small className="muted">
						This project chooses its teams here. Teams are put together on the <a href="#/teams">Teams page</a>. Assigning one copies its subagents, rules, skills, commands, hooks and MCP servers into this project and commits them.
					</small>
				</div>
			)}
			{groups && (
				<div className="card">
					{groups.map((g) => (
						<div key={g.kind}>
							<strong className="cap">{g.kind === "mcp" ? "MCP servers" : g.kind}</strong>
							{g.items.length === 0 ? (
								<p className="muted">None in the library yet.</p>
							) : (
								<ul className="plain">
									{g.items.map((item) => (
										<li key={item.id}>
											<label className="toggle">
												<input type="checkbox" checked={item.enabled} disabled={busy !== null || item.team !== null} onChange={(e) => toggle(g.kind, item.id, e.target.checked)} />
												<span>
													{item.id}
													{item.team && <small className="muted"> · from team {item.team}</small>}
													{item.summary && <small className="muted"> · {item.summary}</small>}
													{item.enabled && !item.present && <small className="bad-text"> · file missing in the project</small>}
												</span>
											</label>
										</li>
									))}
								</ul>
							)}
						</div>
					))}
					<small className="muted">Switching a feature copies it into (or removes it from) the project, commits that change, and pushes it when the project folder is otherwise in step with GitHub. Hooks and MCP servers run programs on the server during agent runs, so only versions committed in the library can be switched on. Parts that come with a team are switched off by removing the team.</small>
				</div>
			)}
		</section>
	);
}
