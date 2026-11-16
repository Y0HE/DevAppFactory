// Preview and production deployments, and the encrypted variables they receive.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Db, DeploymentRow } from "./db.js";
import type { HostClient } from "./host.js";

const ENVS = ["preview", "production"] as const;
type Env = (typeof ENVS)[number];
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(["APP_HOST", "APP_ENV"]);

function asEnv(env: string): Env {
	if (!ENVS.includes(env as Env)) throw new Error(`unknown environment: ${env}`);
	return env as Env;
}

/** AES-256-GCM with a key derived from FACTORY_SECRET_KEY. Stored as iv.tag.ciphertext, base64. */
function vault(secret: string | undefined) {
	const key = secret ? createHash("sha256").update(secret).digest() : null;
	const need = () => {
		if (!key) throw new Error("FACTORY_SECRET_KEY is not set, so variables cannot be stored. Add it to the factory's .env file and restart.");
		return key;
	};
	return {
		ready: Boolean(key),
		encrypt(text: string): string {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", need(), iv);
			const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
			return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
		},
		decrypt(stored: string): string {
			const [iv, tag, body] = stored.split(".").map((p) => Buffer.from(p, "base64"));
			const decipher = createDecipheriv("aes-256-gcm", need(), iv);
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
		},
	};
}

export function deploymentService(db: Db, host: HostClient, secret: string | undefined, onLive: (project: string, env: string) => void = () => {}) {
	const v = vault(secret);
	const busy = new Set<string>();

	function project(name: string) {
		const row = db.getProject(name);
		if (!row) throw new Error("project not found");
		return row;
	}

	async function execute(name: string, env: Env, id: number, sha: string | undefined) {
		const row = project(name);
		const key = `${row.id}/${env}`;
		try {
			const previous = db.liveDeployments(row.id, env)[0];
			const vars = Object.fromEntries(db.listVars(row.id, env).map((x) => [x.key, v.decrypt(x.value)]));
			const res = await host.post<any>(`/projects/${name}/deploy/${env}`, {
				sha,
				previousSha: previous?.sha ?? undefined,
				vars,
				auth: env === "preview" ? true : row.prod_auth === 1,
			});
			db.updateDeployment(id, {
				status: res.ok ? "live" : "failed",
				sha: res.sha ?? sha ?? null,
				subject: res.subject ?? null,
				log: (res.log ?? []).join("\n"),
				rolled_back: res.rolledBack ? 1 : 0,
				ended_at: new Date().toISOString(),
			});
			if (res.ok) onLive(name, env);
		} catch (err) {
			db.updateDeployment(id, { status: "failed", log: (err as Error).message, ended_at: new Date().toISOString() });
		} finally {
			busy.delete(key);
		}
	}

	/** Starts a deployment and returns its record at once; the work continues in the background. */
	function start(name: string, envName: string, opts: { sha?: string; trigger: string }): DeploymentRow {
		const env = asEnv(envName);
		const row = project(name);
		const key = `${row.id}/${env}`;
		if (busy.has(key)) throw new Error(`a ${env} deployment of this project is already running`);

		let sha = opts.sha;
		if (env === "production" && !sha) {
			// Production only receives what is live on preview.
			sha = db.liveDeployments(row.id, "preview")[0]?.sha ?? undefined;
			if (!sha) throw new Error("deploy to preview first; production receives the commit that is live on preview");
		}
		busy.add(key);
		const id = db.insertDeployment({ project_id: row.id, env, sha: sha ?? null, status: "deploying", trigger: opts.trigger });
		void execute(name, env, id, sha);
		return db.listDeployments(row.id).find((d) => d.id === id)!;
	}

	return {
		start,

		rollback(name: string, envName: string) {
			const env = asEnv(envName);
			const live = db.liveDeployments(project(name).id, env);
			const current = live[0];
			const target = live.find((d) => d.sha !== current?.sha);
			if (!current || !target?.sha) throw new Error("there is no earlier successful deployment to return to");
			return start(name, env, { sha: target.sha, trigger: `rollback from ${current.sha?.slice(0, 7)}` });
		},

		stop: (name: string, envName: string) => (project(name), host.post(`/projects/${name}/deploy/${asEnv(envName)}/stop`, {})),

		async overview(name: string) {
			const row = project(name);
			const history = db.listDeployments(row.id);
			const [latest, ...statuses] = await Promise.all([
				host.get<any>(`/projects/${name}/latest`).catch(() => null),
				...ENVS.map((env) => host.get<any>(`/projects/${name}/deploy/${env}`).catch((err) => ({ env, state: "error", detail: (err as Error).message }))),
			]);
			return {
				latest,
				prodAuth: row.prod_auth === 1,
				variablesReady: v.ready,
				envs: ENVS.map((env, i) => ({
					...statuses[i],
					env,
					deploying: busy.has(`${row.id}/${env}`),
					live: db.liveDeployments(row.id, env)[0] ?? null,
					canRollBack: new Set(db.liveDeployments(row.id, env).map((d) => d.sha)).size > 1,
					variables: db.listVars(row.id, env).map((x) => ({ key: x.key, updated_at: x.updated_at })),
				})),
				history,
			};
		},

		setProdAuth(name: string, on: boolean) {
			db.setProdAuth(project(name).id, on);
			return { ok: true };
		},

		setVar(name: string, envName: string, key: string, value: string) {
			if (!VAR_NAME.test(key) || RESERVED.has(key)) throw new Error("use letters, digits and underscores for the name; APP_HOST and APP_ENV are set by the factory");
			if (/[\r\n]/.test(value)) throw new Error("values cannot contain line breaks");
			db.setVar(project(name).id, asEnv(envName), key, v.encrypt(value));
			return { ok: true };
		},

		deleteVar(name: string, envName: string, key: string) {
			db.deleteVar(project(name).id, asEnv(envName), key);
			return { ok: true };
		},

		/** After a restart: a deployment that was in flight has an unknown outcome. */
		recover() {
			for (const d of db.deploymentsByStatus("deploying")) {
				db.updateDeployment(d.id, { status: "failed", log: "The factory restarted during this deployment; its outcome is unknown. Check the environment and deploy again.", ended_at: new Date().toISOString() });
			}
		},
	};
}
