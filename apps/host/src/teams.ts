// Teams: a named set of subagents with the rules, skills, commands, hooks and MCP servers they
// work with. A team lives in the kit library and can be assigned to any number of projects.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { config } from "./config.js";
import { commitAndSync } from "./git.js";
import { componentLists, componentPaths, installComponent, KINDS, listComponents, pendingExecutables, removeComponent, type Kind } from "./kits.js";
import { projectPath } from "./projects.js";

const ID = /^[a-z0-9][a-z0-9-]{0,48}$/;

export interface Team {
	id: string;
	version: number;
	description: string;
	/** The subagent that leads a run when the user picks this team's lead for it. */
	lead?: string;
	components: Record<Kind, string[]>;
}

/** What a project records about an assigned team: enough to remove it without the library. */
interface Assigned {
	version: number;
	lead?: string;
	components: Partial<Record<Kind, string[]>>;
}

const teamsDir = () => join(config.kitsDir, "teams");

export function loadTeam(id: string): Team {
	if (!ID.test(id ?? "")) throw new Error(`invalid team name: ${id}`);
	const file = join(teamsDir(), id, "team.yml");
	if (!existsSync(file)) throw new Error(`team not found: ${id}`);
	const raw = parse(readFileSync(file, "utf8")) ?? {};
	const components = componentLists(raw.components);
	const lead = typeof raw.lead === "string" && components.agents.includes(raw.lead) ? raw.lead : undefined;
	return { id, version: Number(raw.version ?? 1), description: String(raw.description ?? ""), lead, components };
}

export function listTeams() {
	const ids = existsSync(teamsDir()) ? readdirSync(teamsDir()).filter((id) => ID.test(id) && existsSync(join(teamsDir(), id, "team.yml"))) : [];
	const teams = ids.sort().flatMap((id) => {
		try {
			return [loadTeam(id)];
		} catch {
			return []; // an unreadable manifest shows up as a validation problem on the Kits page
		}
	});
	return { teams, library: Object.fromEntries(KINDS.map((kind) => [kind, listComponents(kind)])) };
}

/** Creates or changes a team in the library, as an uncommitted change there. */
export function saveTeam(id: string, body: { description?: unknown; lead?: unknown; components?: unknown }) {
	if (!ID.test(id ?? "")) throw new Error("use lowercase letters, digits and dashes for the team name");
	const components = componentLists(body.components);
	for (const kind of KINDS) for (const cid of components[kind]) componentPaths(kind, cid); // must exist in the library
	if (!components.agents.length) throw new Error("a team needs at least one subagent");
	const lead = typeof body.lead === "string" && body.lead ? body.lead : undefined;
	if (lead && !components.agents.includes(lead)) throw new Error("the lead must be one of the team's subagents");
	const description = String(body.description ?? "").trim().slice(0, 400);

	const file = join(teamsDir(), id, "team.yml");
	let version = 1;
	if (existsSync(file)) {
		const old = loadTeam(id);
		const same = old.description === description && old.lead === lead && KINDS.every((k) => old.components[k].join() === components[k].join());
		if (same) return { ok: true, team: old, changed: false };
		version = old.version + 1;
	}
	const kept = Object.fromEntries(KINDS.filter((k) => components[k].length).map((k) => [k, components[k]]));
	mkdirSync(join(teamsDir(), id), { recursive: true });
	writeFileSync(file, stringify({ name: id, version, description, ...(lead ? { lead } : {}), components: kept }));
	return { ok: true, team: loadTeam(id), changed: true };
}

function readMeta(dir: string): any {
	const file = join(dir, ".factory", "project.yml");
	if (!existsSync(file)) throw new Error("this project has no .factory/project.yml");
	return parse(readFileSync(file, "utf8")) ?? {};
}

function assigned(meta: any): Record<string, Assigned> {
	const out: Record<string, Assigned> = {};
	for (const [id, value] of Object.entries(meta?.teams ?? {})) {
		const v = value as any;
		if (ID.test(id)) out[id] = { version: Number(v?.version ?? 0), lead: typeof v?.lead === "string" ? v.lead : undefined, components: componentLists(v?.components) };
	}
	return out;
}

/** For every component a team brings into the project: which team. */
export function teamComponents(meta: any): Map<string, string> {
	const owner = new Map<string, string>();
	for (const [team, a] of Object.entries(assigned(meta))) {
		for (const kind of KINDS) for (const id of a.components[kind] ?? []) if (!owner.has(`${kind}/${id}`)) owner.set(`${kind}/${id}`, team);
	}
	return owner;
}

/** Everything that should be in the project: components switched on one by one, plus those of its teams. */
function effective(meta: any): Set<string> {
	const own = componentLists(meta?.components);
	return new Set([...KINDS.flatMap((kind) => own[kind].map((id) => `${kind}/${id}`)), ...teamComponents(meta).keys()]);
}

/** Checks that every named team can be given to a project now, and returns them. */
export async function loadTeamsForProject(ids: unknown): Promise<Team[]> {
	if (ids === undefined || ids === null) return [];
	if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("teams must be a list of team names");
	const teams = [...new Set(ids as string[])].map(loadTeam);
	for (const team of teams) {
		for (const kind of KINDS) for (const cid of team.components[kind]) componentPaths(kind, cid);
		const pending = await pendingExecutables(team.components);
		if (pending.length) throw new Error(`Commit these on the Kits page first, because they run programs on the server: ${pending.join(", ")}`);
	}
	return teams;
}

/**
 * Gives teams to a project folder that has just been written from a kit, without committing:
 * project creation commits the kit and the teams together.
 */
export function installTeams(dir: string, teams: Team[]): void {
	if (!teams.length) return;
	const meta = readMeta(dir);
	const record = assigned(meta);
	for (const team of teams) {
		for (const kind of KINDS) for (const cid of team.components[kind]) installComponent(dir, kind, cid);
		record[team.id] = { version: team.version, ...(team.lead ? { lead: team.lead } : {}), components: Object.fromEntries(KINDS.filter((k) => team.components[k].length).map((k) => [k, team.components[k]])) };
	}
	meta.teams = record;
	writeFileSync(join(dir, ".factory", "project.yml"), stringify(meta));
}

export function projectTeams(project: string) {
	const dir = projectPath(project);
	const teams = Object.entries(assigned(readMeta(dir))).map(([id, a]) => {
		let latest: number | null = null;
		try {
			latest = loadTeam(id).version;
		} catch {}
		return { id, version: a.version, lead: a.lead ?? null, latest, updateAvailable: latest !== null && latest !== a.version, components: a.components };
	});
	const agentsDir = join(dir, ".claude", "agents");
	const agents = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((id) => ID.test(id)).sort() : [];
	return { teams, agents };
}

/**
 * Assigns a team to a project (or brings an assigned one up to the library's version), or removes it.
 * Components are copied into the project and the change is committed there, like a feature toggle.
 */
export async function setTeam(project: string, id: string, assign: boolean) {
	const dir = projectPath(project);
	const meta = readMeta(dir);
	const teams = assigned(meta);
	const before = effective(meta);
	const paths = new Set<string>([".factory/project.yml"]);
	let message: string;

	if (assign) {
		const team = loadTeam(id);
		for (const kind of KINDS) for (const cid of team.components[kind]) componentPaths(kind, cid);
		const pending = await pendingExecutables(team.components);
		if (pending.length) throw new Error(`Commit these on the Kits page first, because they run programs on the server: ${pending.join(", ")}`);
		const had = teams[id]?.version;
		message = had === undefined ? `Assign team ${id} (version ${team.version})` : `Update team ${id} from version ${had} to ${team.version}`;
		const kept = Object.fromEntries(KINDS.filter((k) => team.components[k].length).map((k) => [k, team.components[k]]));
		teams[id] = { version: team.version, ...(team.lead ? { lead: team.lead } : {}), components: kept };
		meta.teams = teams;
		for (const kind of KINDS) for (const cid of team.components[kind]) for (const p of installComponent(dir, kind, cid)) paths.add(p);
	} else {
		if (!teams[id]) throw new Error(`team ${id} is not assigned to ${project}`);
		message = `Remove team ${id}`;
		delete teams[id];
		meta.teams = teams;
	}
	// Keep the record short: only the kinds a team actually brings.
	for (const a of Object.values(teams)) a.components = Object.fromEntries(KINDS.filter((k) => a.components[k]?.length).map((k) => [k, a.components[k]]));
	if (!Object.keys(teams).length) delete meta.teams;

	// Take out what no team and no individual switch asks for any more.
	const after = effective(meta);
	for (const key of before) {
		if (after.has(key)) continue;
		const [kind, cid] = key.split("/") as [Kind, string];
		for (const p of removeComponent(dir, kind, cid)) paths.add(p);
	}
	writeFileSync(join(dir, ".factory", "project.yml"), stringify(meta));
	const { committed, pushed } = await commitAndSync(dir, [...paths], message);
	return { ok: true, project, committed, pushed, ...projectTeams(project) };
}
