import { useCallback, useEffect, useState } from "react";
import { api, type Team, type TeamsOverview } from "./api";

// Members first: a team is its subagents, then what they work with.
const KINDS: { kind: string; label: string; hint?: string }[] = [
	{ kind: "agents", label: "Subagents (the team members)" },
	{ kind: "rules", label: "Rules" },
	{ kind: "skills", label: "Skills" },
	{ kind: "commands", label: "Commands" },
	{ kind: "hooks", label: "Hooks", hint: "run a program on the server during agent runs" },
	{ kind: "mcp", label: "MCP servers", hint: "start a program or call a service during agent runs" },
	{ kind: "workflows", label: "Workflows" },
];
const NAME = /^[a-z0-9][a-z0-9-]{0,48}$/;
const empty = (): Record<string, string[]> => Object.fromEntries(KINDS.map((k) => [k.kind, []]));

/** `initial` is the team named in the address (#/teams/<id>), opened once the list has loaded. */
export function TeamsPage({ initial }: { initial?: string }) {
	const [data, setData] = useState<TeamsOverview | null>(null);
	const [pending, setPending] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// The team being edited: an existing one, or a new one that has only a name so far.
	const [id, setId] = useState<string | null>(null);
	const [isNew, setIsNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [description, setDescription] = useState("");
	const [lead, setLead] = useState("");
	const [picked, setPicked] = useState<Record<string, string[]>>(empty);

	const refresh = useCallback(
		() =>
			Promise.all([api.teams(), api.lib.tree()])
				.then(([t, tree]) => (setData(t), setPending(tree.pending), t))
				.catch((e) => (setError(e.message), null)),
		[],
	);
	useEffect(() => {
		void refresh().then((t) => {
			const wanted = t?.teams.find((x) => x.id === initial);
			if (wanted) open(wanted);
		});
	}, [refresh]);

	const team = data?.teams.find((t) => t.id === id) ?? null;
	const assignedTo = (teamId: string) => (data?.projects ?? []).filter((p) => p.teams && teamId in p.teams);

	function open(t: Team) {
		// Keep the address in step, so the page can be linked to and reloaded on the same team.
		history.replaceState(null, "", `#/teams/${t.id}`);
		setId(t.id);
		setIsNew(false);
		setDescription(t.description);
		setLead(t.lead ?? "");
		setPicked({ ...empty(), ...t.components });
		setInfo(null);
		setError(null);
	}

	function startNew() {
		setId(newName);
		setIsNew(true);
		setDescription("");
		setLead("");
		setPicked(empty());
		setNewName("");
		setInfo(null);
		setError(null);
	}

	const changed = team ? team.description !== description.trim() || (team.lead ?? "") !== lead || KINDS.some((k) => (team.components[k.kind] ?? []).join() !== (picked[k.kind] ?? []).join()) : isNew;

	function toggle(kind: string, cid: string, on: boolean) {
		// Library order, so the saved list does not depend on the order of clicks.
		const order = (data?.library[kind] ?? []).map((c) => c.id);
		const next = new Set(picked[kind] ?? []);
		if (on) next.add(cid);
		else next.delete(cid);
		setPicked({ ...picked, [kind]: order.filter((x) => next.has(x)) });
		if (kind === "agents" && !on && lead === cid) setLead("");
	}

	async function save() {
		if (!id) return;
		setBusy(true);
		setError(null);
		try {
			const res = await api.saveTeam(id, { description, lead, components: picked });
			const fresh = await refresh();
			if (fresh) open(res.team);
			setInfo(res.changed ? `Saved as version ${res.team.version}. It is a pending change in the library until you commit it on the Kits page.` : "Nothing changed.");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<main>
			<section>
				<h2>Teams</h2>
				<p className="muted">
					A team is a set of subagents together with the rules, skills, commands, hooks and MCP servers they work with. Teams are put together here. A project chooses its teams when it is created, and on its own page afterwards; each project gets its own copy, committed in its repository, and can be updated there when the team changes.
				</p>
				{pending > 0 && (
					<p className="muted">
						The library has {pending} pending {pending === 1 ? "change" : "changes"}. <a href="#/kits">Review and commit on the Kits page.</a>
					</p>
				)}
				{error && <p className="error">{error}</p>}
			</section>

			<section className="lib">
				<div className="card lib-nav">
					<strong>Teams</strong>
					{!data ? (
						<p className="muted">Loading…</p>
					) : data.teams.length === 0 ? (
						<p className="muted">No teams yet.</p>
					) : (
						<ul className="plain">
							{data.teams.map((t) => (
								<li key={t.id}>
									<button className={`link ${id === t.id && !isNew ? "current" : ""}`} onClick={() => open(t)}>
										{t.id}
										<span className="muted">
											{" "}
											· v{t.version} · {t.components.agents?.length ?? 0} {t.components.agents?.length === 1 ? "member" : "members"} · {assignedTo(t.id).length} {assignedTo(t.id).length === 1 ? "project" : "projects"}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
					<form
						className="stack"
						onSubmit={(e) => {
							e.preventDefault();
							startNew();
						}}
					>
						<strong>New team</strong>
						<input value={newName} onChange={(e) => setNewName(e.target.value.toLowerCase())} placeholder="name-with-dashes" aria-label="Team name" required />
						<button type="submit" disabled={!NAME.test(newName) || !data || data.teams.some((t) => t.id === newName)}>
							Create
						</button>
					</form>
				</div>

				<div className="card lib-edit">
					{!id || !data ? (
						<p className="muted">Choose a team, or create one.</p>
					) : (
						<>
							<div className="run-head">
								<strong>{id}</strong>
								{team ? <span className="pill">version {team.version}</span> : <span className="pill live">not saved yet</span>}
								{team && (
									<a className="push-right" href="#/kits">
										Edit team.yml on the Kits page
									</a>
								)}
							</div>
							<label>
								What this team is for
								<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={400} disabled={busy} />
							</label>
							{KINDS.map(({ kind, label, hint }) => {
								const items = data.library[kind] ?? [];
								return (
									<fieldset key={kind} className="pick">
										<legend>
											{label}
											{hint && <small className="muted"> · {hint}</small>}
										</legend>
										{items.length === 0 ? (
											<small className="muted">None in the library yet. Create one on the Kits page.</small>
										) : (
											<ul className="plain">
												{items.map((c) => (
													<li key={c.id}>
														<label className="toggle">
															<input type="checkbox" checked={(picked[kind] ?? []).includes(c.id)} disabled={busy} onChange={(e) => toggle(kind, c.id, e.target.checked)} />
															<span>
																{c.id}
																{c.summary && <small className="muted"> · {c.summary}</small>}
															</span>
														</label>
													</li>
												))}
											</ul>
										)}
									</fieldset>
								);
							})}
							<label>
								Lead
								<select value={lead} onChange={(e) => setLead(e.target.value)} disabled={busy}>
									<option value="">No lead</option>
									{(picked.agents ?? []).map((a) => (
										<option key={a} value={a}>
											{a}
										</option>
									))}
								</select>
								<small className="muted">The member suggested to lead a run in projects that have this team. The other members are called on by whoever leads.</small>
							</label>
							<div className="actions">
								{info && <span className="muted push-left">{info}</span>}
								<button className="primary" disabled={busy || !changed || (picked.agents ?? []).length === 0} onClick={save}>
									{team ? "Save as new version" : "Save team"}
								</button>
							</div>

							{team && (
								<>
									<strong>Used by</strong>
									{assignedTo(team.id).length === 0 ? (
										<p className="muted">No project has this team. A project takes a team when it is created, or under "AI features" on its page.</p>
									) : (
										<ul className="plain">
											{assignedTo(team.id).map((p) => {
												const has = p.teams?.[team.id];
												return (
													<li key={p.name}>
														<a href={`#/projects/${p.name}`}>{p.name}</a>
														{has === team.version ? <small className="muted"> · has version {has}</small> : <small className="bad-text"> · has version {has}; update it to {team.version} on the project's page</small>}
													</li>
												);
											})}
										</ul>
									)}
								</>
							)}
						</>
					)}
				</div>
			</section>
		</main>
	);
}
