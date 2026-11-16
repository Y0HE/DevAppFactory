// Preview and production deployments: a pinned clone per environment, started with docker compose
// and published through the gateway. See docs/DESIGN.md section 9.4.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { config } from "./config.js";
import { projectMeta } from "./devenv.js";
import { run } from "./exec.js";
import { addSite, ensureEdge, siteExists, siteUrl } from "./gateway.js";
import { baseBranch } from "./pipeline.js";
import { projectPath } from "./projects.js";

export type Env = "preview" | "production";
const ENVS: Record<Env, { site: (p: string) => string; alias: (p: string) => string }> = {
	preview: { site: (p) => `${p}-preview`, alias: (p) => `${p}-preview` },
	production: { site: (p) => p, alias: (p) => `${p}-prod` },
};
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(["APP_HOST", "APP_ENV"]);

function target(project: string, env: string) {
	projectPath(project); // validates the name
	if (env !== "preview" && env !== "production") throw new Error(`unknown environment: ${env}`);
	const e = ENVS[env];
	return { env, dir: join(config.deployDir, project, env), composeProject: `${project}-${env}`, site: e.site(project), alias: e.alias(project) };
}

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, timeoutMs: 180_000 });

function composeFile(dir: string): string {
	for (const f of ["docker-compose.deploy.yml", "docker-compose.yml", "compose.yml", "compose.yaml"]) if (existsSync(join(dir, f))) return f;
	throw new Error("the repository has no docker compose file to deploy");
}

/** Refuses compose configurations that could reach beyond the deploy folder or the container boundary. */
export function unsafeReasons(resolved: any, dir: string): string[] {
	const root = realpathSync(dir);
	const reasons: string[] = [];
	for (const [name, svc] of Object.entries<any>(resolved?.services ?? {})) {
		if (svc.privileged) reasons.push(`${name}: privileged mode`);
		if (svc.network_mode === "host") reasons.push(`${name}: host network`);
		if (svc.pid === "host" || svc.ipc === "host" || svc.userns_mode === "host") reasons.push(`${name}: host namespace`);
		if (svc.cap_add?.length) reasons.push(`${name}: added capabilities`);
		if (svc.devices?.length) reasons.push(`${name}: host devices`);
		if (svc.security_opt?.length) reasons.push(`${name}: security options`);
		for (const v of svc.volumes ?? []) {
			if (v.type !== "bind") continue;
			const source = String(v.source ?? "");
			if (source !== root && !source.startsWith(root + sep)) reasons.push(`${name}: mounts ${source} from outside the deploy folder`);
		}
	}
	return reasons;
}

async function health(alias: string, port: number, path: string, timeoutMs = 90_000): Promise<{ ok: boolean; detail: string }> {
	const url = `http://${alias}:${port}${path.startsWith("/") ? path : `/${path}`}`;
	const deadline = Date.now() + timeoutMs;
	let detail = "";
	for (;;) {
		// From inside the gateway container, so success also proves the gateway can reach the app.
		const res = await run("docker", ["exec", config.gatewayContainer, "wget", "-q", "-T", "5", "-O", "/dev/null", url], { timeoutMs: 15_000 });
		if (res.ok) return { ok: true, detail: `${url} answered` };
		detail = res.stderr || `no answer from ${url}`;
		if (Date.now() > deadline) return { ok: false, detail: `${url} did not answer within ${timeoutMs / 1000}s: ${detail}` };
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}
}

async function describe(dir: string, rev = "HEAD") {
	const res = await git(dir, "log", "-1", "--format=%H%x09%h%x09%cI%x09%s", rev);
	const [sha, short, at, subject] = res.stdout.split("\t");
	return res.ok ? { sha, short, at, subject } : null;
}

export interface DeployRequest {
	/** Commit to deploy; the head of origin's default branch when omitted. */
	sha?: string;
	/** Commit that is live now, to return to if this one fails its health check. */
	previousSha?: string;
	vars?: Record<string, string>;
	/** Protect the site with the gateway's basic auth. */
	auth?: boolean;
}

export async function deploy(project: string, envName: string, req: DeployRequest) {
	const t = target(project, envName);
	const log: string[] = [];
	const step = (text: string) => log.push(text);
	const fail = (reason: string, extra: object = {}) => ({ ok: false, env: t.env, reason, log: [...log, reason], ...extra });
	if (req.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(req.sha)) throw new Error("invalid commit");
	for (const key of Object.keys(req.vars ?? {})) {
		if (!VAR_NAME.test(key) || RESERVED.has(key)) throw new Error(`invalid variable name: ${key}`);
	}

	// 1. Checkout
	if (!existsSync(join(t.dir, ".git"))) {
		const origin = (await git(projectPath(project), "remote", "get-url", "origin")).stdout;
		if (!origin) return fail("The project has no GitHub remote.");
		mkdirSync(dirname(t.dir), { recursive: true });
		const cloned = await git(dirname(t.dir), "clone", "--quiet", origin, t.dir);
		if (!cloned.ok) return fail(`git clone failed: ${cloned.stderr}`);
		step(`Cloned ${origin}`);
	}
	const fetched = await git(t.dir, "fetch", "--quiet", "--prune", "origin");
	if (!fetched.ok) return fail(`git fetch failed: ${fetched.stderr}`);
	const wanted = req.sha ?? "origin/HEAD";
	const commit = await describe(t.dir, wanted);
	if (!commit) return fail(`Commit ${wanted} was not found on GitHub.`);

	const compose = async (args: string[], timeoutMs = 120_000) => run("docker", ["compose", "-p", t.composeProject, "-f", composeFile(t.dir), ...args], { cwd: t.dir, timeoutMs });

	async function start(sha: string): Promise<{ ok: boolean; reason?: string }> {
		const out = await git(t.dir, "checkout", "--quiet", "--detach", sha);
		if (!out.ok) return { ok: false, reason: `git checkout failed: ${out.stderr}` };

		// 2-3. Compose file and safety
		let file: string;
		try {
			file = composeFile(t.dir);
		} catch (err) {
			return { ok: false, reason: (err as Error).message };
		}
		// 4. Environment file, before resolving the config (it substitutes these values)
		const lines = [`APP_HOST=${t.alias}`, `APP_ENV=${t.env}`, ...Object.entries(req.vars ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`)];
		writeFileSync(join(t.dir, ".env"), lines.join("\n") + "\n", { mode: 0o600 });
		chmodSync(join(t.dir, ".env"), 0o600);

		const resolved = await compose(["config", "--format", "json"]);
		if (!resolved.ok) return { ok: false, reason: `The compose file is not valid: ${resolved.stderr}` };
		const reasons = unsafeReasons(JSON.parse(resolved.stdout), t.dir);
		if (reasons.length) return { ok: false, reason: `Refused for safety: ${reasons.join("; ")}.` };
		step(`Using ${file} at ${sha.slice(0, 7)}`);

		// 5. Start
		await ensureEdge();
		const up = await compose(["up", "-d", "--build", "--remove-orphans"], 15 * 60_000);
		if (!up.ok) return { ok: false, reason: `docker compose up failed: ${(up.stderr || up.stdout).slice(-1500)}` };

		// 6. Health
		const meta = projectMeta(project, t.dir);
		const checked = await health(t.alias, Number(meta.runtime?.port ?? 80), String(meta.runtime?.health ?? "/"));
		step(checked.detail);
		return checked.ok ? { ok: true } : { ok: false, reason: `Health check failed: ${checked.detail}` };
	}

	const started = await start(commit.sha);
	if (!started.ok) {
		const logs = await compose(["logs", "--no-color", "--tail", "40"]).catch(() => null);
		if (logs?.stdout) step(`Last container output:\n${logs.stdout.slice(-3000)}`);
		if (req.previousSha && req.previousSha !== commit.sha) {
			step(`Returning to ${req.previousSha.slice(0, 7)}`);
			const back = await start(req.previousSha);
			return fail(started.reason!, { sha: commit.sha, rolledBack: back.ok, rollbackError: back.ok ? undefined : back.reason });
		}
		await compose(["stop"]).catch(() => null);
		return fail(started.reason!, { sha: commit.sha, rolledBack: false });
	}

	// 7. Gateway
	const meta = projectMeta(project, t.dir);
	try {
		const site = await addSite(t.site, `${t.alias}:${Number(meta.runtime?.port ?? 80)}`, req.auth !== false);
		if (site.created) step(`Published ${siteUrl(t.site)}${req.auth === false ? " without login" : " behind basic auth"}`);
	} catch (err) {
		return fail(`The app is running but could not be published: ${(err as Error).message}`, { sha: commit.sha, rolledBack: false });
	}
	return { ok: true, env: t.env, sha: commit.sha, short: commit.short, subject: commit.subject, url: siteUrl(t.site), log, rolledBack: false };
}

export async function deployStatus(project: string, envName: string) {
	const t = target(project, envName);
	const base = { env: t.env, url: siteUrl(t.site), published: siteExists(t.site) };
	if (!existsSync(join(t.dir, ".git"))) return { ...base, state: "never", commit: null };
	const ps = await run("docker", ["compose", "-p", t.composeProject, "ps", "-a", "--format", "json"], { cwd: t.dir });
	const containers = ps.stdout
		.split("\n")
		.filter((l) => l.trim().startsWith("{"))
		.map((l) => JSON.parse(l));
	const running = containers.filter((c) => c.State === "running").length;
	return {
		...base,
		state: containers.length === 0 ? "stopped" : running === containers.length ? "running" : running === 0 ? "stopped" : "partial",
		commit: await describe(t.dir),
		services: containers.map((c) => ({ service: c.Service, status: c.Status })),
	};
}

export async function deployStop(project: string, envName: string) {
	const t = target(project, envName);
	if (!existsSync(join(t.dir, ".git"))) throw new Error("this environment has never been deployed");
	const res = await run("docker", ["compose", "-p", t.composeProject, "stop"], { cwd: t.dir, timeoutMs: 120_000 });
	return { ok: res.ok, status: await deployStatus(project, envName) };
}

/** Head of origin's default branch, as GitHub has it now. */
export async function latestMain(project: string) {
	const main = projectPath(project);
	await git(main, "fetch", "--quiet", "origin");
	return describe(main, `origin/${await baseBranch(main)}`);
}
