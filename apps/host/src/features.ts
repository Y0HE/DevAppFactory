// AI features of a project: which library components are switched on.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { commitAndSync } from "./git.js";
import { componentPaths, isInstalled, installComponent, KINDS, listComponents, pendingExecutables, removeComponent, type Kind } from "./kits.js";
import { projectPath } from "./projects.js";
import { teamComponents } from "./teams.js";

const LABEL: Record<Kind, string> = { rules: "rule", skills: "skill", agents: "subagent", commands: "command", workflows: "workflow", hooks: "hook", mcp: "MCP server" };

function readMeta(dir: string): any {
	const file = join(dir, ".factory", "project.yml");
	if (!existsSync(file)) throw new Error("this project has no .factory/project.yml");
	return parse(readFileSync(file, "utf8")) ?? {};
}

export function listFeatures(name: string) {
	const dir = projectPath(name);
	const meta = readMeta(dir);
	const enabled = meta.components ?? {};
	const fromTeam = teamComponents(meta);
	return KINDS.map((kind) => ({
		kind,
		label: LABEL[kind],
		items: listComponents(kind).map((c) => {
			const team = fromTeam.get(`${kind}/${c.id}`) ?? null;
			const on = team !== null || (enabled[kind] ?? []).includes(c.id);
			return { ...c, enabled: on, present: isInstalled(dir, kind, c.id), team };
		}),
	}));
}

export async function setFeature(name: string, kind: string, id: string, enabled: boolean) {
	if (!KINDS.includes(kind as Kind)) throw new Error(`unsupported feature kind: ${kind}`);
	const k = kind as Kind;
	const dir = projectPath(name);
	const meta = readMeta(dir);
	meta.components ??= {};
	const list: string[] = Array.isArray(meta.components[k]) ? meta.components[k] : [];
	const team = teamComponents(meta).get(`${k}/${id}`);

	let touched: string[] = [];
	if (enabled) {
		componentPaths(k, id);
		const pending = await pendingExecutables({ [k]: [id] });
		if (pending.length) throw new Error(`Commit ${pending[0]} on the Kits page first, because it runs a program on the server.`);
		touched = installComponent(dir, k, id);
	} else if (team) {
		// Still part of a team: only drop the individual switch, the files stay.
		if (!list.includes(id)) throw new Error(`This ${LABEL[k]} comes with team ${team}. Remove the team, or take it out of the team, to switch it off.`);
	} else {
		touched = removeComponent(dir, k, id);
	}
	meta.components[k] = enabled ? [...new Set([...list, id])].sort() : list.filter((x) => x !== id);
	writeFileSync(join(dir, ".factory", "project.yml"), stringify(meta));

	// Commit only the files this change touched, and keep GitHub in step so feature branches include it.
	const { committed, pushed } = await commitAndSync(dir, [...touched, ".factory/project.yml"], `${enabled ? "Enable" : "Disable"} ${LABEL[k]} ${id}`);
	return { ok: true, committed, pushed, features: listFeatures(name) };
}
