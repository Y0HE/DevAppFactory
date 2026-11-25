import { userInfo } from "node:os";
// factory-host: the only part of DevAppFactory that touches the server.
// Listens on a Unix socket and exposes a fixed set of operations; there is no generic "run command".
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { run } from "./exec.js";
import { ensureKitLibrary, listKits } from "./kits.js";
import { createProject, ghOwner, gitDetail, gitState } from "./projects.js";
import { devAction, devLogs, devStatus, listChecks, runCheck } from "./devenv.js";
import { listFeatures, setFeature } from "./features.js";
import { domain } from "./gateway.js";
import * as pipeline from "./pipeline.js";
import { commitDocs, readDoc } from "./docs.js";
import * as kitlib from "./kitlib.js";
import * as cleanup from "./cleanup.js";
import { applyUpgrade, kitStatus, promote } from "./kitsync.js";
import { deploy, deployStatus, deployStop, latestMain } from "./deploy.js";
import * as teams from "./teams.js";
import * as runs from "./runs.js";
import * as claudeAuth from "./claudeauth.js";

async function status() {
	const [authStatus, claudeVersion, gh, docker, gateway] = await Promise.all([
		run("claude", ["auth", "status"], { timeoutMs: 15_000, env: { ...process.env, ...claudeAuth.claudeAuthEnv() } }),
		run("claude", ["--version"], { timeoutMs: 15_000 }),
		run("gh", ["api", "user", "-q", ".login"], { timeoutMs: 15_000 }),
		run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 }),
		run("docker", ["inspect", "-f", "{{.State.Running}}", config.gatewayContainer], { timeoutMs: 15_000 }),
	]);
	let loggedIn = false;
	try {
		loggedIn = JSON.parse(authStatus.stdout).loggedIn === true;
	} catch {}
	const token = claudeAuth.tokenInfo();
	return {
		host: { ok: true, home: config.home, defaultModel: config.defaultModel || undefined, sshTarget: config.sshTarget || `${userInfo().username}@factory.${domain()}` },
		claude: {
			ok: loggedIn,
			version: claudeVersion.stdout || undefined,
			detail: loggedIn ? (token ? "long-lived token" : "logged in") : "not signed in: use Connect Claude",
			token,
		},
		github: { ok: gh.ok, user: gh.ok ? gh.stdout : undefined, detail: gh.ok ? undefined : gh.stderr },
		docker: { ok: docker.ok, version: docker.ok ? docker.stdout : undefined, detail: docker.ok ? undefined : docker.stderr },
		gateway: { ok: gateway.stdout === "true", container: config.gatewayContainer },
	};
}

type Handler = (body: any, match: RegExpMatchArray) => Promise<unknown>;
const routes: [method: string, pattern: RegExp, handler: Handler][] = [
	["GET", /^\/health$/, async () => ({ ok: true })],
	["GET", /^\/status$/, status],
	["GET", /^\/kits$/, async () => listKits()],
	["POST", /^\/projects$/, async (body) => createProject(body)],
	["GET", /^\/projects\/([a-z0-9-]+)\/git$/, async (_body, m) => gitState(m[1])],
	["GET", /^\/projects\/([a-z0-9-]+)\/git\/detail$/, async (_body, m) => gitDetail(m[1])],
	["GET", /^\/projects\/([a-z0-9-]+)\/dev$/, async (_body, m) => devStatus(m[1])],
	["POST", /^\/projects\/([a-z0-9-]+)\/dev\/(up|stop|restart)$/, async (body, m) => devAction(m[1], m[2], body.feature)],
	["GET", /^\/projects\/([a-z0-9-]+)\/dev\/logs$/, async (_body, m) => devLogs(m[1])],
	["GET", /^\/projects\/([a-z0-9-]+)\/checks$/, async (_body, m) => listChecks(m[1])],
	["POST", /^\/projects\/([a-z0-9-]+)\/checks\/([a-z0-9_-]+)$/, async (_body, m) => runCheck(m[1], m[2])],
	["GET", /^\/projects\/([a-z0-9-]+)\/features$/, async (_body, m) => listFeatures(m[1])],
	["POST", /^\/projects\/([a-z0-9-]+)\/features$/, async (body, m) => setFeature(m[1], body.kind, body.id, body.enabled === true)],
	["POST", /^\/projects\/([a-z0-9-]+)\/worktrees$/, async (b, m) => pipeline.createWorktree(m[1], b.slug, String(b.title ?? ""), String(b.description ?? ""))],
	["GET", /^\/projects\/([a-z0-9-]+)\/worktrees\/([a-z0-9-]+)$/, async (_b, m) => pipeline.worktreeInfo(m[1], m[2])],
	["POST", /^\/projects\/([a-z0-9-]+)\/worktrees\/([a-z0-9-]+)\/check$/, async (_b, m) => pipeline.checkWorktree(m[1], m[2])],
	["POST", /^\/projects\/([a-z0-9-]+)\/worktrees\/([a-z0-9-]+)\/pr$/, async (b, m) => pipeline.openPr(m[1], m[2], String(b.title ?? ""), String(b.body ?? ""))],
	["GET", /^\/projects\/([a-z0-9-]+)\/worktrees\/([a-z0-9-]+)\/pr$/, async (_b, m) => pipeline.prStatus(m[1], m[2])],
	["POST", /^\/projects\/([a-z0-9-]+)\/worktrees\/([a-z0-9-]+)\/merge$/, async (_b, m) => pipeline.mergePr(m[1], m[2])],
	["POST", /^\/projects\/([a-z0-9-]+)\/worktrees\/([a-z0-9-]+)\/discard$/, async (_b, m) => pipeline.discard(m[1], m[2])],
	["GET", /^\/projects\/([a-z0-9-]+)\/latest$/, async (_b, m) => latestMain(m[1])],
	["GET", /^\/projects\/([a-z0-9-]+)\/deploy\/(preview|production)$/, async (_b, m) => deployStatus(m[1], m[2])],
	["POST", /^\/projects\/([a-z0-9-]+)\/deploy\/(preview|production)$/, async (b, m) => deploy(m[1], m[2], b)],
	["POST", /^\/projects\/([a-z0-9-]+)\/deploy\/(preview|production)\/stop$/, async (_b, m) => deployStop(m[1], m[2])],
	["POST", /^\/projects\/([a-z0-9-]+)\/docs\/read$/, async (b, m) => readDoc(m[1], String(b.path ?? ""))],
	["POST", /^\/projects\/([a-z0-9-]+)\/docs\/commit$/, async (b, m) => commitDocs(m[1], b.paths, b.message)],
	["GET", /^\/kitlib\/tree$/, async () => kitlib.tree()],
	["GET", /^\/kitlib\/pending$/, async () => kitlib.pending()],
	["POST", /^\/kitlib\/files$/, async (b) => kitlib.files(b.path)],
	["POST", /^\/kitlib\/read$/, async (b) => kitlib.read(b.path)],
	["POST", /^\/kitlib\/write$/, async (b) => kitlib.write(b.path, b.content)],
	["POST", /^\/kitlib\/remove$/, async (b) => kitlib.remove(b.path)],
	["POST", /^\/kitlib\/create$/, async (b) => kitlib.create(b.type, b.id, b.from)],
	["POST", /^\/kitlib\/commit$/, async (b) => kitlib.commit(b.message)],
	["POST", /^\/kitlib\/discard$/, async () => kitlib.discard()],
	["GET", /^\/cleanup$/, async () => cleanup.storage()],
	["POST", /^\/cleanup\/run-log$/, async (b) => cleanup.deleteRunLog(b.id)],
	["POST", /^\/cleanup\/worktree$/, async (b) => cleanup.deleteWorktree(b.project, b.slug)],
	["POST", /^\/cleanup\/session$/, async (b) => cleanup.deleteSession(b.folder, b.id)],
	["GET", /^\/kitlib\/seed$/, async () => kitlib.seedStatus()],
	["POST", /^\/kitlib\/pull-seed$/, async (b) => kitlib.pullSeed(b.paths)],
	["GET", /^\/projects\/([a-z0-9-]+)\/kit$/, async (_b, m) => kitStatus(m[1])],
	["POST", /^\/projects\/([a-z0-9-]+)\/kit\/promote$/, async (b, m) => promote(m[1], b.kind, b.id)],
	["POST", /^\/projects\/([a-z0-9-]+)\/worktrees\/([a-z0-9-]+)\/upgrade$/, async (_b, m) => applyUpgrade(m[1], m[2])],
	["GET", /^\/teams$/, async () => teams.listTeams()],
	["POST", /^\/teams\/([a-z0-9-]+)$/, async (b, m) => teams.saveTeam(m[1], b)],
	["GET", /^\/projects\/([a-z0-9-]+)\/teams$/, async (_b, m) => teams.projectTeams(m[1])],
	["POST", /^\/projects\/([a-z0-9-]+)\/teams$/, async (b, m) => teams.setTeam(m[1], String(b.id ?? ""), b.assign !== false)],
	["GET", /^\/claude-auth$/, async () => ({ token: claudeAuth.tokenInfo() })],
	["POST", /^\/claude-auth\/login$/, async () => claudeAuth.startLogin()],
	["POST", /^\/claude-auth\/login\/finish$/, async (b) => claudeAuth.finishLogin(b.id, b.code)],
	["POST", /^\/claude-auth\/login\/cancel$/, async () => claudeAuth.cancelLogin()],
	["POST", /^\/claude-auth\/token$/, async (b) => claudeAuth.saveToken(b.token)],
	["POST", /^\/claude-auth\/clear$/, async () => claudeAuth.clearToken()],
	["POST", /^\/runs$/, async (body) => runs.start(body)],
	["GET", /^\/runs\/([0-9a-f-]{36})$/, async (_body, m) => runs.info(m[1])],
	["POST", /^\/runs\/([0-9a-f-]{36})\/message$/, async (body, m) => runs.message(m[1], body.text)],
	["POST", /^\/runs\/([0-9a-f-]{36})\/interrupt$/, async (_body, m) => runs.interrupt(m[1])],
];

function readBody(req: IncomingMessage): Promise<any> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1_000_000) reject(new Error("body too large"));
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				reject(new Error("invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

async function handle(req: IncomingMessage, res: ServerResponse) {
	const send = (code: number, body: unknown) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	const [path, query = ""] = (req.url ?? "/").split("?");

	// Event stream: one JSON object per line, open until the run ends.
	const stream = req.method === "GET" && path.match(/^\/runs\/([0-9a-f-]{36})\/events$/);
	if (stream) {
		if (!runs.known(stream[1])) return send(404, { error: "run not found" });
		const after = Number(new URLSearchParams(query).get("after") ?? -1);
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		await runs.follow(stream[1], after, (event) => res.write(JSON.stringify(event) + "\n"), (stop) => req.on("close", stop));
		res.end();
		return;
	}
	for (const [method, pattern, handler] of routes) {
		const match = req.method === method && path.match(pattern);
		if (!match) continue;
		try {
			send(200, await handler(req.method === "POST" ? await readBody(req) : {}, match));
		} catch (err) {
			send(400, { error: String((err as Error).message) });
		}
		return;
	}
	send(404, { error: "not found" });
}

async function main() {
	mkdirSync(dirname(config.socket), { recursive: true });
	mkdirSync(config.projectsDir, { recursive: true });
	await ensureKitLibrary();
	if (existsSync(config.socket)) unlinkSync(config.socket);

	const server = createServer((req, res) => void handle(req, res));
	server.listen(config.socket, async () => {
		chmodSync(config.socket, 0o600);
		console.log(`factory-host listening on ${config.socket} (GitHub owner: ${await ghOwner().catch(() => "unknown")})`);
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => server.close(() => process.exit(0)));
	}
}

void main();
