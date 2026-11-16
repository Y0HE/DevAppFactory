import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type LibItem, type LibPending, type LibSeed, type LibTree, type Run } from "./api";
import { RunsTable } from "./RunsTable";

const KIND_LABEL: Record<string, string> = { rules: "Rules", skills: "Skills", agents: "Subagents", commands: "Commands", workflows: "Workflows", hooks: "Hooks", mcp: "MCP servers", scaffolds: "Scaffolds" };
const TYPES = [
	{ value: "kit", label: "Kit" },
	{ value: "team", label: "Team" },
	{ value: "rules", label: "Rule" },
	{ value: "skills", label: "Skill" },
	{ value: "agents", label: "Subagent" },
	{ value: "commands", label: "Command" },
	{ value: "workflows", label: "Workflow" },
	{ value: "hooks", label: "Hook" },
	{ value: "mcp", label: "MCP server" },
	{ value: "scaffolds", label: "Scaffold (copy of base)" },
];
const MODELS = [
	{ value: "", label: "Default model" },
	{ value: "haiku", label: "Haiku" },
	{ value: "sonnet", label: "Sonnet" },
	{ value: "opus", label: "Opus" },
];

export function KitsPage() {
	const [tree, setTree] = useState<LibTree | null>(null);
	const [pending, setPending] = useState<LibPending | null>(null);
	const [runs, setRuns] = useState<Run[]>([]);
	const [item, setItem] = useState<LibItem | null>(null);
	const [files, setFiles] = useState<string[]>([]);
	const [file, setFile] = useState<string | null>(null);
	const [content, setContent] = useState("");
	const [saved, setSaved] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [newType, setNewType] = useState("rules");
	const [newId, setNewId] = useState("");
	const [message, setMessage] = useState("");
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [seed, setSeed] = useState<LibSeed | null>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());

	const refresh = useCallback(() => {
		api.lib.tree().then(setTree).catch((e) => setError(e.message));
		api.lib.pending().then(setPending).catch(() => {});
		api.lib.runs().then(setRuns).catch(() => {});
		api.lib.seed().then(setSeed).catch(() => {});
	}, []);
	// New files are ticked by default; a file the library has in another version is only replaced on request.
	const seedKey = seed?.files.map((f) => `${f.state}:${f.path}`).join("|") ?? "";
	useEffect(() => {
		setPicked(new Set((seed?.files ?? []).filter((f) => f.state === "new").map((f) => f.path)));
	}, [seedKey]);
	const pick = (path: string, on: boolean) => {
		const next = new Set(picked);
		if (on) next.add(path);
		else next.delete(path);
		setPicked(next);
	};
	const agentActive = runs.some((r) => r.status === "running" || r.status === "queued");
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, agentActive ? 3_000 : 20_000);
		return () => clearInterval(timer);
	}, [refresh, agentActive]);

	const dirty = file !== null && content !== saved;

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

	async function openFile(path: string) {
		if (dirty && !confirm("Discard your unsaved edits to this file?")) return;
		const res = await api.lib.read(path);
		setFile(path);
		setContent(res.content);
		setSaved(res.content);
	}

	async function openItem(next: LibItem, preferred?: string) {
		if (dirty && !confirm("Discard your unsaved edits to this file?")) return;
		setError(null);
		try {
			const list = await api.lib.files(next.path);
			setItem(next);
			setFiles(list);
			const first = preferred && list.includes(preferred) ? preferred : list[0];
			if (first) {
				const res = await api.lib.read(first);
				setFile(first);
				setContent(res.content);
				setSaved(res.content);
			} else {
				setFile(null);
				setContent("");
				setSaved("");
			}
		} catch (err) {
			setError((err as Error).message);
		}
	}

	function create(e: FormEvent) {
		e.preventDefault();
		void act("create", async () => {
			const res = await api.lib.create(newType, newId.trim());
			setNewId("");
			const parts = res.path.split("/");
			const top = newType === "kit" || newType === "team";
			const isDir = top || ["rules", "skills", "hooks", "scaffolds"].includes(newType);
			const path = top ? parts.slice(0, 2).join("/") : isDir ? parts.slice(0, 3).join("/") : res.path;
			await openItem({ id: newId.trim(), path, dir: isDir }, res.path);
		});
	}

	function startAgent(e: FormEvent) {
		e.preventDefault();
		void act("agent", async () => {
			await api.lib.startRun(prompt, model || undefined);
			setPrompt("");
		});
	}

	const group = (title: string, list: LibItem[]) => (
		<div key={title}>
			<strong>{title}</strong>
			{list.length === 0 ? (
				<p className="muted">None.</p>
			) : (
				<ul className="plain">
					{list.map((i) => (
						<li key={i.path}>
							<button className={`link ${item?.path === i.path ? "current" : ""}`} onClick={() => openItem(i)}>
								{i.id}
								{i.version ? <span className="muted"> · v{i.version}</span> : null}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);

	return (
		<main>
			<section>
				<h2>Kit library</h2>
				<p className="muted">
					Kits, teams and their components are copied into projects. Teams are put together on the <a href="#/teams">Teams page</a>. Changes here are saved as pending changes first; commit them to make them part of the library. Projects pick up a new kit version through "Upgrade" on their page.
				</p>
				{error && <p className="error">{error}</p>}
			</section>

			<section className="lib">
				<div className="card lib-nav">
					{tree ? (
						<>
							{group("Kits", tree.kits)}
							{group("Teams", tree.teams ?? [])}
							{Object.entries(tree.components).map(([kind, list]) => group(KIND_LABEL[kind] ?? kind, list))}
						</>
					) : (
						<p className="muted">Loading…</p>
					)}
					<form onSubmit={create} className="stack">
						<strong>New</strong>
						<select value={newType} onChange={(e) => setNewType(e.target.value)} aria-label="Type">
							{TYPES.map((t) => (
								<option key={t.value} value={t.value}>
									{t.label}
								</option>
							))}
						</select>
						<input value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} placeholder="name-with-dashes" aria-label="Name" required />
						<button type="submit" disabled={busy !== null || !/^[a-z0-9][a-z0-9-]*$/.test(newId)}>
							Create
						</button>
					</form>
				</div>

				<div className="card lib-edit">
					{!item ? (
						<p className="muted">Choose a kit, team or component to view and edit it.</p>
					) : (
						<>
							<div className="run-head">
								<code>{item.path}</code>
								<button
									className="push-right"
									disabled={busy !== null}
									onClick={() => {
										if (confirm(`Delete ${item.path}? It stays recoverable until you commit.`)) void act("delete", () => api.lib.remove(item.path).then(() => (setItem(null), setFile(null), setFiles([]))));
									}}
								>
									Delete
								</button>
							</div>
							{files.length > 1 && (
								<div className="button-row start">
									{files.map((f) => (
										<button key={f} className={f === file ? "primary" : ""} onClick={() => openFile(f)}>
											{f.slice(item.path.length + 1)}
										</button>
									))}
								</div>
							)}
							{file && (
								<>
									<textarea className="code" value={content} onChange={(e) => setContent(e.target.value)} rows={22} spellCheck={false} aria-label={`Contents of ${file}`} />
									<div className="actions">
										<span className="muted push-left">{dirty ? "Unsaved edits" : "Saved"}</span>
										<button className="primary" disabled={!dirty || busy !== null} onClick={() => act("save", () => api.lib.write(file, content).then(() => setSaved(content)))}>
											Save
										</button>
									</div>
								</>
							)}
						</>
					)}
				</div>
			</section>

			{seed && seed.files.length > 0 && (
				<section>
					<h2>Updates from the factory ({seed.files.length})</h2>
					<div className="card">
						<p className="muted">
							DevAppFactory ships a seed library that is copied only when the factory first starts. These files of the seed are missing from this library or differ from it. Copying puts them under Pending changes, where you review and commit them. Nothing is deleted.
						</p>
						<ul className="plain mono">
							{seed.files.map((f) => (
								<li key={f.path}>
									<label>
										<input type="checkbox" checked={picked.has(f.path)} disabled={busy !== null} onChange={(e) => pick(f.path, e.target.checked)} /> <span className="code-tag">{f.state === "new" ? "new" : "differs"}</span> {f.path}
									</label>
								</li>
							))}
						</ul>
						{seed.files.some((f) => f.state === "differs") && <small className="muted">"differs" can mean the seed is newer or that you edited the file here. Ticking it replaces this library's version with the seed's.</small>}
						<div className="actions spread">
							<span className="button-row start">
								<button disabled={busy !== null} onClick={() => setPicked(new Set(seed.files.map((f) => f.path)))}>
									Select all
								</button>
								<button disabled={busy !== null} onClick={() => setPicked(new Set())}>
									Select none
								</button>
							</span>
							<button className="primary" disabled={busy !== null || picked.size === 0 || dirty} onClick={() => act("seed", () => api.lib.pullSeed([...picked]))}>
								Copy {picked.size} into the library
							</button>
						</div>
					</div>
				</section>
			)}

			<section>
				<h2>Pending changes{pending ? ` (${pending.changes.length})` : ""}</h2>
				{pending && pending.errors.length > 0 && (
					<div className="card gap-below">
						<strong className="bad-text">Problems to fix before committing</strong>
						<ul className="plain">
							{pending.errors.map((e) => (
								<li key={e} className="bad-text">
									{e}
								</li>
							))}
						</ul>
					</div>
				)}
				{!pending || pending.changes.length === 0 ? (
					<p className="empty">Nothing to commit. The library matches its last commit.</p>
				) : (
					<div className="card">
						<ul className="plain mono">
							{pending.changes.map((c) => (
								<li key={c.path}>
									<span className="code-tag">{c.code}</span> {c.path}
								</li>
							))}
						</ul>
						<pre className="output">{pending.diff || "(new files only)"}</pre>
						<div className="var-form">
							<input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed, in a few words" aria-label="Commit message" />
							<button className="primary" disabled={busy !== null || pending.errors.length > 0 || !message.trim() || dirty} onClick={() => act("commit", () => api.lib.commit(message).then(() => setMessage("")))}>
								Commit
							</button>
							<button
								disabled={busy !== null}
								onClick={() => {
									if (confirm("Discard all pending changes in the library? This cannot be undone.")) void act("discard", () => api.lib.discard().then(() => (setItem(null), setFile(null), setFiles([]))));
								}}
							>
								Discard all
							</button>
						</div>
						{dirty && <small className="muted">Save or drop your unsaved edits before committing.</small>}
					</div>
				)}
			</section>

			<section>
				<h2>Create or improve with an agent</h2>
				<form className="card" onSubmit={startAgent}>
					<label>
						Task
						<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="For example: add a rule about accessible HTML, or create a kit for a FastAPI service based on the base kit." required disabled={busy !== null} />
					</label>
					<div className="actions spread">
						<select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
							{MODELS.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
						<button className="primary" type="submit" disabled={busy !== null || !prompt.trim() || agentActive}>
							{agentActive ? "Agent working…" : "Start agent"}
						</button>
					</div>
					<small className="muted">The agent edits library files only; it cannot run commands or commit. Its edits appear under Pending changes for you to review.</small>
				</form>
				{runs.length > 0 && (
					<div className="gap-above">
						<RunsTable runs={runs} />
					</div>
				)}
			</section>
		</main>
	);
}
