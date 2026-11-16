// A project's dev environment: its docker compose stack, served at <name>-dev.<domain>.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { config } from "./config.js";
import { run } from "./exec.js";
import { addSite, ensureEdge, siteExists, siteUrl } from "./gateway.js";
import { projectPath } from "./projects.js";

/** `.factory/project.yml` of the project folder, or of another checkout of it (a feature worktree). */
export function projectMeta(name: string, dir = projectPath(name)): any {
	try {
		return parse(readFileSync(join(dir, ".factory", "project.yml"), "utf8")) ?? {};
	} catch {
		return {};
	}
}

// The compose project is always named after the factory project, whichever folder it is started
// from. That lets the dev URL serve a feature worktree by re-running `up` there.
const compose = (name: string, args: string[], timeoutMs = 60_000, dir = projectPath(name)) =>
	run("docker", ["compose", "-p", name, ...args], { cwd: dir, timeoutMs });

export async function devStatus(name: string) {
	const dir = projectPath(name);
	const site = `${name}-dev`;
	const hasCompose = ["docker-compose.yml", "compose.yml", "compose.yaml"].some((f) => existsSync(join(dir, f)));
	const base = { site, url: siteUrl(site), published: siteExists(site), hasCompose, edgeNetwork: config.edgeNetwork };
	if (!hasCompose) return { ...base, state: "none", services: [], onEdge: false };

	const ps = await compose(name, ["ps", "-a", "--format", "json"]);
	const services = ps.stdout
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.map((line) => JSON.parse(line))
		.map((c: any) => ({ service: c.Service, state: c.State, status: c.Status, networks: String(c.Networks ?? "").split(","), id: c.ID as string }));
	// Which folder the running stack was started from: the project itself or a feature worktree.
	let servingDir: string | undefined;
	if (services[0]?.id) {
		const label = await run("docker", ["inspect", "-f", '{{index .Config.Labels "com.docker.compose.project.working_dir"}}', services[0].id]);
		if (label.ok && label.stdout) servingDir = label.stdout;
	}
	const servingFeature = servingDir?.startsWith(join(config.worktreesDir, name) + "/") ? servingDir.split("/").pop() : undefined;
	const running = services.filter((s) => s.state === "running").length;
	return {
		...base,
		services,
		state: !ps.ok ? "error" : services.length === 0 ? "stopped" : running === services.length ? "running" : running === 0 ? "stopped" : "partial",
		// Without a container on the edge network the gateway cannot reach the app.
		onEdge: services.some((s) => s.networks.includes(config.edgeNetwork)),
		servingFeature,
		detail: ps.ok ? undefined : ps.stderr,
	};
}

export async function devAction(name: string, action: string, feature?: string) {
	const notes: string[] = [];
	let res;
	if (action === "up") {
		let dir = projectPath(name);
		if (feature) {
			if (!/^[a-z0-9][a-z0-9-]*$/.test(feature)) throw new Error("invalid feature");
			dir = join(config.worktreesDir, name, feature);
			if (!existsSync(dir)) throw new Error("feature worktree not found");
		}
		await ensureEdge(); // the compose file refers to it as an external network
		res = await compose(name, ["up", "-d", "--build", "--remove-orphans"], 15 * 60_000, dir);
		if (res.ok) {
			const port = Number(projectMeta(name).runtime?.port ?? 80);
			const site = await addSite(`${name}-dev`, `${name}-dev:${port}`);
			if (site.created) notes.push(`Published ${siteUrl(`${name}-dev`)}.`);
			if (site.gatewayRestarted) notes.push("The gateway was restarted once to join the shared network.");
		}
	} else if (action === "stop") {
		res = await compose(name, ["stop"], 120_000);
	} else if (action === "restart") {
		res = await compose(name, ["restart"], 120_000);
	} else {
		throw new Error(`unknown action: ${action}`);
	}
	return { ok: res.ok, output: (res.stderr || res.stdout).slice(-6000), notes, status: await devStatus(name) };
}

export async function devLogs(name: string) {
	const res = await compose(name, ["logs", "--no-color", "--tail", "200"]);
	return { ok: res.ok, logs: (res.stdout || res.stderr).slice(-40_000) };
}

/** Runs one of the kit's check commands. No shell: the command is split on spaces. */
export async function runCheck(name: string, check: string, dir = projectPath(name)) {
	const meta = projectMeta(name, dir);
	const command = meta.checks?.[check];
	if (typeof command !== "string") throw new Error(`check not found: ${check}`);
	const allowed: string[] = Array.isArray(meta.allowed_commands) ? meta.allowed_commands : [];
	if (!allowed.some((prefix) => command === prefix || command.startsWith(prefix + " "))) {
		throw new Error(`check command is not on the project's allowlist: ${command}`);
	}
	const [file, ...args] = command.trim().split(/\s+/);
	const started = Date.now();
	const res = await run(file, args, { cwd: dir, timeoutMs: 15 * 60_000 });
	return { check, command, ok: res.ok, code: res.code, durationMs: Date.now() - started, output: [res.stdout, res.stderr].filter(Boolean).join("\n").slice(-40_000) };
}

export function listChecks(name: string, dir = projectPath(name)) {
	const checks = projectMeta(name, dir).checks ?? {};
	return Object.entries(checks).map(([id, command]) => ({ id, command: String(command) }));
}
