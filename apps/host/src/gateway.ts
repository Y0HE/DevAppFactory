// Gateway integration: every change goes through the gateway's own script. What the factory relies on:
//   <GATEWAY_DIR>/scripts/gateway.sh add <site> <host:port> <network> [--auth] | remove <site> | reload
//   <GATEWAY_DIR>/sites/<site>.caddy   one file per site, containing "reverse_proxy <host:port>"
//                                      and a line "import basicauth" when it requires a login
//   <GATEWAY_DIR>/.env                 DOMAIN=<domain>, unless FACTORY_DOMAIN is set
//   a container named GATEWAY_CONTAINER that has `wget` and is on the edge network
// The bundled gateway (deploy/gateway) provides exactly this; any other that does can be used instead.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { run } from "./exec.js";

const SITE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const gw = (...args: string[]) => run(join(config.gatewayDir, "scripts", "gateway.sh"), args, { timeoutMs: 180_000 });

export function domain(): string {
	if (config.domain) return config.domain;
	try {
		return readFileSync(join(config.gatewayDir, ".env"), "utf8").match(/^DOMAIN=(.+)$/m)?.[1].trim() ?? "localhost";
	} catch {
		return "localhost";
	}
}

export const siteUrl = (site: string) => `https://${site}.${domain()}`;
export const siteExists = (site: string) => SITE.test(site) && existsSync(join(config.gatewayDir, "sites", `${site}.caddy`));

async function gatewayOnEdge(): Promise<boolean> {
	const res = await run("docker", ["inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", config.gatewayContainer]);
	return res.ok && res.stdout.split(/\s+/).includes(config.edgeNetwork);
}

/** Makes sure the shared edge network exists. Returns whether the gateway has joined it yet. */
export async function ensureEdge(): Promise<{ joined: boolean }> {
	if (!(await run("docker", ["network", "inspect", config.edgeNetwork])).ok) {
		const created = await run("docker", ["network", "create", config.edgeNetwork]);
		if (!created.ok) throw new Error(`cannot create network ${config.edgeNetwork}: ${created.stderr}`);
	}
	return { joined: await gatewayOnEdge() };
}

/**
 * Publishes https://<site>.<domain> -> upstream, behind basic auth.
 * The first site ever added makes the gateway join the edge network, which
 * recreates the Caddy container (a few seconds of downtime for all sites).
 * Later sites only reload the config.
 */
export async function addSite(site: string, upstream: string, auth = true): Promise<{ created: boolean; gatewayRestarted: boolean }> {
	if (!SITE.test(site)) throw new Error(`invalid site name: ${site}`);
	if (!/^[a-z0-9-]+:\d{1,5}$/.test(upstream)) throw new Error(`invalid upstream: ${upstream}`);
	const { joined } = await ensureEdge();

	const file = join(config.gatewayDir, "sites", `${site}.caddy`);
	let exists = siteExists(site);
	if (exists) {
		const current = readFileSync(file, "utf8");
		// Never take over a site that points somewhere else: it belongs to another project on this server.
		if (!current.includes(`reverse_proxy ${upstream}`)) throw new Error(`the gateway already has a site "${site}" that does not belong to this app`);
		const hasAuth = /^\s*import basicauth\s*$/m.test(current);
		if (hasAuth === auth && joined) return { created: false, gatewayRestarted: false };
		if (hasAuth !== auth) {
			const removed = await gw("remove", site);
			if (!removed.ok) throw new Error(`gateway remove failed: ${removed.stderr || removed.stdout}`);
			exists = false;
		}
	}

	if (!exists) {
		const added = await gw("add", site, upstream, config.edgeNetwork, ...(auth ? ["--auth"] : []));
		if (!added.ok) throw new Error(`gateway add failed: ${added.stderr || added.stdout}`);
	}
	// `add` with an already-known network does not reload by itself.
	const reloaded = await gw("reload");
	if (!reloaded.ok) throw new Error(`gateway reload failed: ${reloaded.stderr || reloaded.stdout}`);

	const git = (...args: string[]) => run("git", args, { cwd: config.gatewayDir });
	const paths = [`sites/${site}.caddy`, "docker-compose.yml"];
	await git("add", "--", ...paths);
	await git("commit", "-q", "-m", `Add ${site} site (DevAppFactory)`, "--", ...paths);
	return { created: true, gatewayRestarted: !joined };
}
