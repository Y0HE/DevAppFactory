import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type DeployOverview, type EnvStatus } from "./api";
import { StatusPill } from "./RunsTable";

const TITLE = { preview: "Preview", production: "Production" } as const;

function Variables({ name, env, ready, onChange }: { name: string; env: EnvStatus; ready: boolean; onChange: () => void }) {
	const [key, setKey] = useState("");
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function run(fn: () => Promise<unknown>) {
		setError(null);
		try {
			await fn();
			onChange();
		} catch (err) {
			setError((err as Error).message);
		}
	}
	function add(e: FormEvent) {
		e.preventDefault();
		void run(() => api.setVariable(name, env.env, key.trim(), value).then(() => (setKey(""), setValue(""))));
	}

	return (
		<details className="vars">
			<summary>
				Variables and secrets ({env.variables.length})
			</summary>
			{!ready ? (
				<p className="error">The factory has no encryption key configured, so variables cannot be stored.</p>
			) : (
				<>
					<ul className="plain">
						{env.variables.map((v) => (
							<li key={v.key} className="var-row">
								<code>{v.key}</code>
								<span className="muted">hidden · set {new Date(v.updated_at).toLocaleDateString()}</span>
								<button type="button" onClick={() => confirm(`Remove ${v.key} from ${env.env}?`) && run(() => api.deleteVariable(name, env.env, v.key))}>
									Remove
								</button>
							</li>
						))}
					</ul>
					<form className="var-form" onSubmit={add}>
						<input value={key} onChange={(e) => setKey(e.target.value)} placeholder="NAME" aria-label="Variable name" required />
						<input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" aria-label="Variable value" type="password" autoComplete="off" required />
						<button type="submit" disabled={!key.trim() || !value}>
							Save
						</button>
					</form>
					<small className="muted">Values are stored encrypted and never shown again. They take effect at the next deployment of this environment.</small>
					{error && <p className="error">{error}</p>}
				</>
			)}
		</details>
	);
}

export function DeploymentsSection({ name }: { name: string }) {
	const [data, setData] = useState<DeployOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [openLog, setOpenLog] = useState<number | null>(null);

	const refresh = useCallback(() => {
		api.deployments(name)
			.then((d) => setData(d))
			.catch((e) => setError(e.message));
	}, [name]);

	const deploying = data?.envs.some((e) => e.deploying) ?? false;
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, deploying ? 3_000 : 20_000);
		return () => clearInterval(timer);
	}, [refresh, deploying]);

	async function act(id: string, fn: () => Promise<unknown>) {
		setBusy(id);
		setError(null);
		try {
			await fn();
			refresh();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	}

	if (!data) return error ? <p className="error">{error}</p> : null;
	const preview = data.envs.find((e) => e.env === "preview")!;

	return (
		<section>
			<h2>Deployments</h2>
			{error && <p className="error">{error}</p>}
			<div className="env-grid">
				{data.envs.map((env) => {
					const running = env.state === "running";
					const disabled = !!busy || env.deploying;
					const behind = env.env === "preview" && data.latest && env.live?.sha !== data.latest.sha;
					const promotable = env.env === "production" && preview.live?.sha && preview.live.sha !== env.live?.sha;
					return (
						<div key={env.env} className="card">
							<div className="run-head">
								<strong>{TITLE[env.env]}</strong>
								<span className={`pill ${env.deploying ? "live" : running ? "ok" : ""}`}>{env.deploying ? "deploying…" : env.state === "never" ? "not deployed" : env.state}</span>
							</div>
							{env.published && running ? (
								<a href={env.url} target="_blank" rel="noreferrer">
									{env.url}
								</a>
							) : (
								<span className="muted">{env.url}</span>
							)}
							<div>
								<small className="muted">Live commit</small>
								{env.live ? (
									<div>
										<code>{env.live.sha?.slice(0, 7)}</code> {env.live.subject} <span className="muted">· {new Date(env.live.ended_at ?? env.live.created_at).toLocaleString()}</span>
									</div>
								) : (
									<div className="muted">None yet.</div>
								)}
							</div>
							{env.env === "preview" && (
								<p className="muted">
									{data.latest ? (
										behind ? (
											<>
												GitHub main is at <code>{data.latest.short}</code> {data.latest.subject}, which is not deployed here yet.
											</>
										) : (
											"Up to date with main on GitHub."
										)
									) : (
										"Could not read main from GitHub."
									)}
								</p>
							)}
							{env.env === "production" && (
								<label className="toggle">
									<input type="checkbox" checked={data.prodAuth} disabled={disabled} onChange={(e) => act("auth", () => api.setProdAuth(name, e.target.checked))} />
									<span>
										Require login (gateway basic auth)
										<small className="muted"> · applies at the next production deployment</small>
									</span>
								</label>
							)}
							<div className="button-row start">
								{env.env === "preview" ? (
									<button className={behind ? "primary" : ""} disabled={disabled} onClick={() => act("preview", () => api.deploy(name, "preview"))}>
										Deploy latest main
									</button>
								) : (
									<button
										className={promotable ? "primary" : ""}
										disabled={disabled || !preview.live?.sha}
										onClick={() => {
											const what = `${preview.live!.sha!.slice(0, 7)} ${preview.live!.subject ?? ""}`;
											const access = data.prodAuth ? "behind login" : "open to everyone, without login";
											if (confirm(`Deploy ${what} to production at ${env.url}, ${access}?`)) void act("production", () => api.deploy(name, "production"));
										}}
									>
										Promote preview to production
									</button>
								)}
								<button disabled={disabled || !env.canRollBack} onClick={() => confirm(`Return ${env.env} to its previous successful deployment?`) && act("rollback", () => api.rollback(name, env.env))}>
									Roll back
								</button>
								<button disabled={disabled || !running} onClick={() => confirm(`Stop the ${env.env} environment? Its URL will show the "temporarily unavailable" page.`) && act("stop", () => api.stopEnv(name, env.env))}>
									Stop
								</button>
							</div>
							{env.env === "production" && !preview.live?.sha && <small className="muted">Deploy to preview first. Production receives the commit that is live on preview.</small>}
							<Variables name={name} env={env} ready={data.variablesReady} onChange={refresh} />
						</div>
					);
				})}
			</div>

			{data.history.length > 0 && (
				<div className="table-wrap gap-above">
					<table>
						<thead>
							<tr>
								<th>Status</th>
								<th>Environment</th>
								<th>Commit</th>
								<th>Why</th>
								<th>When</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{data.history.map((d) => (
								<Fragment key={d.id}>
									<tr>
										<td>
											<StatusPill status={d.status} />
											{d.rolled_back ? <small className="muted"> rolled back</small> : null}
										</td>
										<td>{d.env}</td>
										<td>
											<code>{d.sha?.slice(0, 7) ?? "–"}</code> {d.subject}
										</td>
										<td>{d.trigger}</td>
										<td>{new Date(d.created_at).toLocaleString()}</td>
										<td>{d.log && <button onClick={() => setOpenLog(openLog === d.id ? null : d.id)}>{openLog === d.id ? "Hide log" : "Log"}</button>}</td>
									</tr>
									{openLog === d.id && (
										<tr>
											<td colSpan={6}>
												<pre className="output">{d.log}</pre>
											</td>
										</tr>
									)}
								</Fragment>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
