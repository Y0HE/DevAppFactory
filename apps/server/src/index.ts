import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { openDb } from "./db.js";
import { hostClient, HostUnavailable } from "./host.js";
import { runService } from "./runs.js";
import { featureService } from "./features.js";
import { deploymentService } from "./deployments.js";
import { phaseService } from "./phases.js";
import { cleanupService } from "./cleanup.js";

// Set by docker-compose.yml from the repo's .env; the fallback is for running the server outside a container.
const home = process.env.FACTORY_HOME || join(homedir(), "factory");
const db = openDb(join(home, "data", "factory.db"));
const host = hostClient(process.env.FACTORY_SOCKET || join(home, "run", "host.sock"));
const runs = runService(db, host, Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS) || 2));
const deployments = deploymentService(db, host, process.env.FACTORY_SECRET_KEY, (project, env) => {
	if (env === "production") phases.released(project);
});
// Every merge done through the factory refreshes preview.
const features = featureService(db, host, runs, (project) => {
	try {
		deployments.start(project, "preview", { trigger: "merge" });
	} catch (err) {
		app.log.warn(`preview deploy after merge skipped: ${(err as Error).message}`);
	}
});
const phases = phaseService(db, host, runs, features);
const cleanup = cleanupService(db, host);
const webDir = process.env.WEB_DIR ?? join(import.meta.dirname, "../../web/dist");

const app = Fastify({ logger: true });

app.setErrorHandler((err: Error, _req, reply) => {
	if (err instanceof HostUnavailable) return reply.code(503).send({ error: err.message });
	app.log.error(err);
	return reply.code(500).send({ error: err.message });
});

app.get("/api/status", async () => {
	try {
		return await host.get("/status");
	} catch (err) {
		if (err instanceof HostUnavailable) return { host: { ok: false, detail: err.message } };
		throw err;
	}
});

app.get("/api/kits", () => host.get("/kits"));

app.get("/api/projects", async () => {
	const rows = db.listProjects();
	return Promise.all(
		rows.map(async (row) => ({
			...row,
			git: await host.get(`/projects/${row.name}/git`).catch(() => null),
		})),
	);
});

interface CreateBody {
	name?: string;
	kit?: string;
	idea?: string;
	visibility?: string;
	teams?: string[];
}

app.post<{ Body: CreateBody }>("/api/projects", async (req, reply) => {
	const { name = "", kit = "", idea = "", visibility = "private", teams = [] } = req.body ?? {};
	const result = await host.post<any>("/projects", { name, kit, idea, visibility, teams });
	if (!result.ok) return reply.code(422).send(result);
	const p = result.project;
	db.insertProject({ name: p.name, repo: p.repo, url: p.url, path: p.path, kit: p.kit, kit_version: p.kitVersion, idea });
	return result;
});

const bad = (reply: any, err: unknown) => reply.code(400).send({ error: (err as Error).message });

app.get<{ Params: { name: string } }>("/api/projects/:name", async (req, reply) => {
	const row = db.getProject(req.params.name);
	if (!row) return reply.code(404).send({ error: "project not found" });
	return { ...row, git: await host.get(`/projects/${row.name}/git`).catch(() => null), runs: db.listRuns(row.name), features: db.listFeatures(row.name) };
});

// Project operations that factory-host performs on the server. The path after the
// project name is forwarded as-is, but only for these patterns.
const FORWARD: [method: "GET" | "POST", pattern: RegExp][] = [
	["GET", /^git\/detail$/],
	["GET", /^dev$/],
	["POST", /^dev\/(up|stop|restart)$/],
	["GET", /^dev\/logs$/],
	["GET", /^checks$/],
	["POST", /^checks\/[a-z0-9_-]+$/],
	["GET", /^features$/],
	["GET", /^kit$/],
	["POST", /^kit\/promote$/],
	["POST", /^features$/],
	["GET", /^teams$/],
	["POST", /^teams$/],
];
app.route<{ Params: { name: string; "*": string } }>({
	method: ["GET", "POST"],
	url: "/api/projects/:name/host/*",
	handler: async (req, reply) => {
		const method = req.method as "GET" | "POST";
		const rest = req.params["*"];
		if (!db.getProject(req.params.name)) return reply.code(404).send({ error: "project not found" });
		if (!FORWARD.some(([m, pattern]) => m === method && pattern.test(rest))) return reply.code(404).send({ error: "not found" });
		const path = `/projects/${req.params.name}/${rest}`;
		try {
			return method === "GET" ? await host.get(path) : await host.post(path, req.body ?? {});
		} catch (err) {
			if (err instanceof HostUnavailable) throw err;
			return bad(reply, err);
		}
	},
});

app.get("/api/runs", () => db.listRuns());

app.post<{ Params: { name: string }; Body: { prompt?: string; model?: string; resumeRunId?: string; agent?: string } }>("/api/projects/:name/runs", async (req, reply) => {
	try {
		return runs.create(req.params.name, req.body ?? {});
	} catch (err) {
		return bad(reply, err);
	}
});

app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => db.getRun(req.params.id) ?? reply.code(404).send({ error: "run not found" }));

app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/runs/:id/message", (req, reply) => runs.message(req.params.id, req.body?.text ?? "").catch((err) => bad(reply, err)));

app.post<{ Params: { id: string } }>("/api/runs/:id/interrupt", (req, reply) => runs.interrupt(req.params.id).catch((err) => bad(reply, err)));

// Live transcript: stored events first, then new ones as they arrive (server-sent events).
app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", (req, reply) => {
	const id = req.params.id;
	if (!db.getRun(id)) return reply.code(404).send({ error: "run not found" });
	reply.hijack();
	const res = reply.raw;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });

	let last = Number(req.headers["last-event-id"] ?? req.query.after ?? -1);
	const send = (e: { seq: number }) => {
		if (e.seq <= last) return;
		last = e.seq;
		res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
	};
	const status = () => res.write(`event: status\ndata: ${JSON.stringify(db.getRun(id))}\n\n`);

	runs.bus.on(id, send);
	runs.bus.on(`${id}:end`, status);
	for (const e of db.listEvents(id, last)) send(e);
	status();
	const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
	req.raw.on("close", () => {
		clearInterval(ping);
		runs.bus.off(id, send);
		runs.bus.off(`${id}:end`, status);
	});
});

const featureId = (req: { params: { id: string } }) => Number(req.params.id);
type IdParams = { Params: { id: string } };

app.get<{ Params: { name: string } }>("/api/projects/:name/features", (req) => db.listFeatures(req.params.name));
app.post<{ Params: { name: string }; Body: { title?: string; description?: string; model?: string } }>("/api/projects/:name/features", (req, reply) =>
	features.create(req.params.name, req.body ?? {}).catch((err) => bad(reply, err)),
);
app.get<IdParams>("/api/features/:id", (req, reply) => features.detail(featureId(req)).catch((err) => bad(reply, err)));
app.post<IdParams & { Body: { text?: string } }>("/api/features/:id/changes", async (req, reply) => {
	try {
		return features.requestChanges(featureId(req), req.body?.text ?? "");
	} catch (err) {
		return bad(reply, err);
	}
});
for (const action of ["recheck", "approve", "merge", "discard", "preview"] as const) {
	app.post<IdParams>(`/api/features/:id/${action}`, (req, reply) => Promise.resolve(features[action](featureId(req))).catch((err) => bad(reply, err)));
}

type NameParams = { Params: { name: string } };
const wrap = (reply: any, fn: () => unknown) => Promise.resolve().then(fn).catch((err) => bad(reply, err));

app.get<NameParams>("/api/projects/:name/deployments", (req, reply) => wrap(reply, () => deployments.overview(req.params.name)));
app.post<NameParams & { Body: { env?: string } }>("/api/projects/:name/deployments", (req, reply) =>
	wrap(reply, () => deployments.start(req.params.name, req.body?.env ?? "", { trigger: req.body?.env === "production" ? "promoted from preview" : "manual" })),
);
app.post<NameParams & { Body: { env?: string } }>("/api/projects/:name/deployments/rollback", (req, reply) => wrap(reply, () => deployments.rollback(req.params.name, req.body?.env ?? "")));
app.post<NameParams & { Body: { env?: string } }>("/api/projects/:name/deployments/stop", (req, reply) => wrap(reply, () => deployments.stop(req.params.name, req.body?.env ?? "")));
app.post<NameParams & { Body: { on?: boolean } }>("/api/projects/:name/deployments/prod-auth", (req, reply) => wrap(reply, () => deployments.setProdAuth(req.params.name, req.body?.on !== false)));
app.post<NameParams & { Body: { env?: string; key?: string; value?: string } }>("/api/projects/:name/variables", (req, reply) =>
	wrap(reply, () => deployments.setVar(req.params.name, req.body?.env ?? "", req.body?.key ?? "", req.body?.value ?? "")),
);
app.post<NameParams & { Body: { env?: string; key?: string } }>("/api/projects/:name/variables/delete", (req, reply) =>
	wrap(reply, () => deployments.deleteVar(req.params.name, req.body?.env ?? "", req.body?.key ?? "")),
);

const asPhase = (value: string) => {
	if (value !== "spec" && value !== "plan") throw new Error("unknown phase");
	return value;
};
app.get<NameParams>("/api/projects/:name/phases", (req, reply) => wrap(reply, () => phases.overview(req.params.name)));
app.post<{ Params: { name: string; phase: string }; Body: { text?: string; model?: string } }>("/api/projects/:name/phases/:phase/message", (req, reply) =>
	wrap(reply, () => phases.start(req.params.name, asPhase(req.params.phase), req.body ?? {})),
);
app.post<{ Params: { name: string; phase: string } }>("/api/projects/:name/phases/:phase/approve", (req, reply) => wrap(reply, () => phases.approve(req.params.name, asPhase(req.params.phase))));
app.post<NameParams & { Body: { on?: boolean } }>("/api/projects/:name/auto-build", (req, reply) => wrap(reply, () => phases.setAutoBuild(req.params.name, req.body?.on !== false)));
app.post<IdParams>("/api/features/:id/start", (req, reply) => wrap(reply, () => features.startPlanned(featureId(req))));

// Kit library. Agent runs on it belong to a hidden system project.
const KITS = "_kits";
db.ensureSystemProject(KITS, join(home, "kits"));
const KIT_AUTHOR = `You are editing the DevAppFactory kit library in this folder. It holds reusable Claude Code configuration that is copied into projects.

Layout: kits/<id>/kit.yml (a preset: version, scaffold, components by kind, checks, runtime, allowed_commands); teams/<id>/team.yml (a team of subagents assigned to projects: name, version, description, optional lead, and components by kind, with at least one entry under components.agents); components/rules/<id>/rule.md; components/skills/<id>/SKILL.md (frontmatter: name, description); components/agents/<id>.md (frontmatter: name, description, tools); components/commands/<id>.md (a slash command: optional description frontmatter, then the instructions); components/hooks/<id>/hook.json ({ "event", "matcher", "command" }, or a list of them, with any script next to it, referred to as "$CLAUDE_PROJECT_DIR"/.claude/hooks/<id>/<script>); components/mcp/<id>.json (one MCP server: { "command", "args" } or { "type": "http", "url" }; never put secrets in it); components/workflows/<id>.yml (GitHub Actions); components/scaffolds/<id>/ (app template files; {{name}} is replaced by the project name).

Read the existing files first and match their style. Keep components short and specific. When you change what a kit or a team includes or how it behaves, raise its version by one. You cannot run commands or commit; the user reviews your edits as a diff. Finish with a short summary of what you changed.

The user's request:
`;
for (const [method, path] of [
	["GET", "tree"],
	["GET", "pending"],
	["POST", "files"],
	["POST", "read"],
	["POST", "write"],
	["POST", "remove"],
	["POST", "create"],
	["POST", "commit"],
	["POST", "discard"],
	["GET", "seed"],
	["POST", "pull-seed"],
] as const) {
	app.route({
		method,
		url: `/api/kitlib/${path}`,
		handler: (req, reply) => wrap(reply, () => (method === "GET" ? host.get(`/kitlib/${path}`) : host.post(`/kitlib/${path}`, req.body ?? {}))),
	});
}
app.get("/api/kitlib/runs", () => db.listRuns(KITS).slice(0, 10));
app.post<{ Body: { prompt?: string; model?: string; resumeRunId?: string } }>("/api/kitlib/runs", (req, reply) =>
	wrap(reply, () => {
		const { prompt = "", model, resumeRunId } = req.body ?? {};
		if (!prompt.trim()) throw new Error("say what the agent should do");
		return runs.create(KITS, { prompt: resumeRunId ? prompt : KIT_AUTHOR + prompt.trim(), model, resumeRunId, purpose: "kit" });
	}),
);

// Cleanup: runs, worktrees and Claude sessions that are no longer needed, with a log of what was deleted.
app.get("/api/cleanup", (_req, reply) => wrap(reply, () => cleanup.overview()));
app.post<{ Body: { ids?: unknown } }>("/api/cleanup/runs", (req, reply) => wrap(reply, () => cleanup.deleteRuns(req.body?.ids)));
app.post<{ Body: { ids?: unknown } }>("/api/cleanup/run-logs", (req, reply) => wrap(reply, () => cleanup.deleteOrphanLogs(req.body?.ids)));
app.post<{ Body: { items?: unknown } }>("/api/cleanup/worktrees", (req, reply) => wrap(reply, () => cleanup.deleteWorktrees(req.body?.items)));
app.post<{ Body: { items?: unknown } }>("/api/cleanup/sessions", (req, reply) => wrap(reply, () => cleanup.deleteSessions(req.body?.items)));

// Teams: defined in the kit library. A project chooses its teams, when it is created or on its page.
app.get("/api/teams", (_req, reply) =>
	wrap(reply, async () => {
		const lib = await host.get<any>("/teams");
		const projects = await Promise.all(
			db.listProjects().map(async (p) => ({
				name: p.name,
				teams: await host
					.get<any>(`/projects/${p.name}/teams`)
					.then((r) => Object.fromEntries(r.teams.map((t: any) => [t.id, t.version])))
					.catch(() => null), // folder missing or not a factory project
			})),
		);
		return { ...lib, projects };
	}),
);
app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/teams/:id", (req, reply) => wrap(reply, () => host.post(`/teams/${req.params.id}`, req.body ?? {})));
app.post<NameParams>("/api/projects/:name/kit/upgrade", (req, reply) => wrap(reply, () => features.createUpgrade(req.params.name)));

runs.recover();
features.recover();
phases.startTicking();
deployments.recover();
features.startPolling();

if (existsSync(webDir)) {
	await app.register(fastifyStatic, { root: webDir });
	app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.sendFile("index.html")));
}

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
