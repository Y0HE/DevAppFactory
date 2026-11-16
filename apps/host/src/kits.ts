// Kit library: list kits and copy one into a project folder.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse, stringify } from "yaml";
import { config } from "./config.js";
import { run } from "./exec.js";

export interface Kit {
	name: string;
	version: number;
	description?: string;
	scaffold?: string;
	components: Record<Kind, string[]>;
	checks: Record<string, string>;
	runtime?: { port?: number; health?: string };
	allowed_commands: string[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Copies the kit library shipped with the repo into the factory home on first start. */
export async function ensureKitLibrary(): Promise<void> {
	if (existsSync(config.kitsDir)) return;
	mkdirSync(dirname(config.kitsDir), { recursive: true });
	cpSync(config.seedKitsDir, config.kitsDir, { recursive: true });
	await run("git", ["init", "-q", "-b", "main"], { cwd: config.kitsDir });
	await run("git", ["add", "-A"], { cwd: config.kitsDir });
	await run("git", ["commit", "-q", "-m", "Seed kit library"], { cwd: config.kitsDir });
}

export function listKits(): Kit[] {
	const dir = join(config.kitsDir, "kits");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((id) => ID.test(id) && existsSync(join(dir, id, "kit.yml")))
		.map(loadKit);
}

export function loadKit(id: string): Kit {
	if (!ID.test(id)) throw new Error(`invalid kit id: ${id}`);
	const file = join(config.kitsDir, "kits", id, "kit.yml");
	if (!existsSync(file)) throw new Error(`kit not found: ${id}`);
	const raw = parse(readFileSync(file, "utf8")) ?? {};
	const c = raw.components ?? {};
	return {
		name: raw.name ?? id,
		version: Number(raw.version ?? 1),
		description: raw.description,
		scaffold: raw.scaffold,
		components: {
			...componentLists(c),
		},
		checks: raw.checks ?? {},
		runtime: raw.runtime,
		allowed_commands: raw.allowed_commands ?? [],
	};
}

/** Component kinds that are plain files copied into the project. */
export const FILE_KINDS = ["rules", "skills", "agents", "commands", "workflows"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
/** Hooks and MCP servers also change `.claude/settings.json` and `.mcp.json`, and they run programs on the server. */
export const KINDS = [...FILE_KINDS, "hooks", "mcp"] as const;
export type Kind = (typeof KINDS)[number];
export const EXECUTABLE_KINDS: readonly Kind[] = ["hooks", "mcp"];

/** A `components:` map from a manifest, with every kind present and only valid ids kept. */
export function componentLists(raw: any): Record<Kind, string[]> {
	const out = {} as Record<Kind, string[]>;
	for (const kind of KINDS) out[kind] = Array.isArray(raw?.[kind]) ? raw[kind].filter((id: unknown): id is string => typeof id === "string" && ID.test(id)) : [];
	return out;
}

/** Where a component goes in a project, relative to the project folder. MCP servers are entries in `.mcp.json`. */
export function projectDest(kind: Kind, id: string): string {
	if (!ID.test(id)) throw new Error(`invalid ${kind} id: ${id}`);
	const map: Record<Kind, string> = {
		rules: join(".claude", "rules", `${id}.md`),
		skills: join(".claude", "skills", id),
		agents: join(".claude", "agents", `${id}.md`),
		commands: join(".claude", "commands", `${id}.md`),
		workflows: join(".github", "workflows", `${id}.yml`),
		hooks: join(".claude", "hooks", id),
		mcp: ".mcp.json",
	};
	return map[kind];
}

/** Where a component lives in the library and where it goes in a project (relative path). */
export function componentPaths(kind: Kind, id: string): { src: string; dest: string; dir: boolean } {
	const dest = projectDest(kind, id);
	const lib = join(config.kitsDir, "components", kind);
	const map: Record<Kind, { src: string; dir: boolean }> = {
		rules: { src: join(lib, id, "rule.md"), dir: false },
		skills: { src: join(lib, id), dir: true },
		agents: { src: join(lib, `${id}.md`), dir: false },
		commands: { src: join(lib, `${id}.md`), dir: false },
		workflows: { src: join(lib, `${id}.yml`), dir: false },
		hooks: { src: join(lib, id), dir: true },
		mcp: { src: join(lib, `${id}.json`), dir: false },
	};
	if (!existsSync(map[kind].src)) throw new Error(`${kind} component not found: ${id}`);
	return { ...map[kind], dest };
}

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "PreCompact", "Notification"];

/** The entries of a hook definition: one object or a list of `{ event, matcher?, command, timeout? }`. */
export function hookEntries(def: unknown): { event: string; matcher?: string; command: string; timeout?: number }[] {
	const list = Array.isArray(def) ? def : [def];
	return list.map((h: any) => {
		if (!h || typeof h !== "object" || !HOOK_EVENTS.includes(h.event)) throw new Error(`event must be one of ${HOOK_EVENTS.join(", ")}`);
		if (typeof h.command !== "string" || !h.command.trim()) throw new Error("command is required");
		if (h.matcher !== undefined && typeof h.matcher !== "string") throw new Error("matcher must be text");
		return { event: h.event, matcher: h.matcher, command: h.command, timeout: Number.isFinite(h.timeout) ? Number(h.timeout) : undefined };
	});
}

/** An MCP server definition as Claude Code expects it: a program to start, or a URL. */
export function mcpDefinition(def: any): Record<string, unknown> {
	if (!def || typeof def !== "object" || Array.isArray(def)) throw new Error("must be a JSON object");
	if (typeof def.command !== "string" && typeof def.url !== "string") throw new Error("needs a command or a url");
	return def;
}

/** Rewrites the hooks in `.claude/settings.json` from the hook folders present in the project. */
function syncHookSettings(dir: string): void {
	const file = join(dir, ".claude", "settings.json");
	const settings = readJson(file);
	const hooks: Record<string, unknown[]> = {};
	const base = join(dir, ".claude", "hooks");
	for (const id of existsSync(base) ? readdirSync(base).filter((e) => ID.test(e)).sort() : []) {
		try {
			for (const h of hookEntries(readJson(join(base, id, "hook.json")))) {
				(hooks[h.event] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: h.command, ...(h.timeout ? { timeout: h.timeout } : {}) }] });
			}
		} catch {} // an invalid definition is simply not active
	}
	if (Object.keys(hooks).length) settings.hooks = hooks;
	else delete settings.hooks;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(settings, null, "\t") + "\n");
}

function setMcpServer(dir: string, id: string, def: Record<string, unknown> | null): void {
	const file = join(dir, ".mcp.json");
	const doc = readJson(file);
	doc.mcpServers = doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {};
	if (def) doc.mcpServers[id] = def;
	else delete doc.mcpServers[id];
	writeFileSync(file, JSON.stringify(doc, null, "\t") + "\n");
}

/** Names of the MCP servers configured in a project folder. */
export function mcpServers(dir: string): string[] {
	return Object.keys(readJson(join(dir, ".mcp.json")).mcpServers ?? {}).filter((id) => ID.test(id));
}

export function isInstalled(dir: string, kind: Kind, id: string): boolean {
	return kind === "mcp" ? mcpServers(dir).includes(id) : existsSync(join(dir, projectDest(kind, id)));
}

/** Copies a component into the project and returns the paths it touched, relative to the project. */
export function installComponent(dir: string, kind: Kind, id: string): string[] {
	const { src, dest, dir: isDir } = componentPaths(kind, id);
	if (kind === "mcp") {
		setMcpServer(dir, id, mcpDefinition(readJson(src)));
		return [dest];
	}
	if (isDir) rmSync(join(dir, dest), { recursive: true, force: true }); // so files dropped from the library copy go too
	mkdirSync(dirname(join(dir, dest)), { recursive: true });
	cpSync(src, join(dir, dest), { recursive: isDir });
	if (kind !== "hooks") return [dest];
	syncHookSettings(dir);
	return [dest, join(".claude", "settings.json")];
}

/** Removes a component from the project; works even when the library no longer has it. */
export function removeComponent(dir: string, kind: Kind, id: string): string[] {
	const dest = projectDest(kind, id);
	if (kind === "mcp") {
		if (existsSync(join(dir, dest))) setMcpServer(dir, id, null);
		return [dest];
	}
	rmSync(join(dir, dest), { recursive: true, force: true });
	if (kind !== "hooks") return [dest];
	syncHookSettings(dir);
	return [dest, join(".claude", "settings.json")];
}

/**
 * Hooks and MCP servers among `components` that have uncommitted changes in the library.
 * They run programs on the server, so only content the user has committed may reach a project.
 */
export async function pendingExecutables(components: Partial<Record<Kind, string[]>>): Promise<string[]> {
	const found: string[] = [];
	for (const kind of EXECUTABLE_KINDS) {
		for (const id of components[kind] ?? []) {
			const rel = relative(config.kitsDir, componentPaths(kind, id).src);
			if ((await run("git", ["status", "--porcelain", "--", rel], { cwd: config.kitsDir })).stdout) found.push(`${kind}/${id}`);
		}
	}
	return found;
}

/** Every component in the library of the given kind, with a one-line summary. */
export function listComponents(kind: Kind): { id: string; summary: string }[] {
	const lib = join(config.kitsDir, "components", kind);
	if (!existsSync(lib)) return [];
	return readdirSync(lib)
		.map((entry) => entry.replace(/\.(md|yml|json)$/, ""))
		.filter((id) => ID.test(id))
		.flatMap((id) => {
			try {
				const { src, dir } = componentPaths(kind, id);
				if (kind === "hooks") return [{ id, summary: hookEntries(readJson(join(src, "hook.json"))).map((h) => `${h.event}${h.matcher ? ` on ${h.matcher}` : ""}`).join(", ") }];
				if (kind === "mcp") {
					const def = mcpDefinition(readJson(src));
					return [{ id, summary: String(def.url ?? [def.command, ...(Array.isArray(def.args) ? def.args : [])].join(" ")).slice(0, 80) }];
				}
				const text = readFileSync(dir ? join(src, "SKILL.md") : src, "utf8");
				const described = text.match(/^description:\s*(.+)$/m)?.[1] ?? text.match(/^#\s+(.+)$/m)?.[1] ?? text.match(/^name:\s*(.+)$/m)?.[1] ?? "";
				return [{ id, summary: described.trim().replace(/^["']|["']$/g, "") }];
			} catch {
				return [];
			}
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

function component(kind: string, id: string, ...rest: string[]): string {
	if (!ID.test(id)) throw new Error(`invalid ${kind} id: ${id}`);
	const path = join(config.kitsDir, "components", kind, id, ...rest);
	if (!existsSync(path)) throw new Error(`${kind} component not found: ${id}`);
	return path;
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

function write(target: string, content: string): void {
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

/** Copies a kit into `dir` and returns the files written, relative to `dir`. */
export function applyKit(dir: string, kit: Kit, project: { name: string; idea: string }): string[] {
	const vars: Record<string, string> = { name: project.name, kit: kit.name };
	const fill = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m);

	if (kit.scaffold) {
		const src = component("scaffolds", kit.scaffold);
		for (const file of walk(src)) {
			let rel = relative(src, file);
			if (rel === "gitignore") rel = ".gitignore"; // stored without the dot so it is not applied to the library itself
			write(join(dir, rel), fill(readFileSync(file, "utf8")));
		}
	}

	const settings = {
		permissions: {
			allow: kit.allowed_commands.map((cmd) => `Bash(${cmd} *)`),
			deny: ["Read(./.env)", "Read(./.env.*)", "Bash(git push *)", "Bash(sudo *)"],
		},
	};
	write(join(dir, ".claude", "settings.json"), JSON.stringify(settings, null, "\t") + "\n");

	// After the settings file exists, because installing a hook adds to it.
	for (const kind of KINDS) {
		for (const id of kit.components[kind]) installComponent(dir, kind, id);
	}

	write(
		join(dir, "CLAUDE.md"),
		[
			`# ${project.name}`,
			"",
			"This project is managed with DevAppFactory. The app idea is in [docs/idea.md](docs/idea.md).",
			"",
			"## Rules",
			"",
			"The working rules are the files in `.claude/rules/`. DevAppFactory adds and removes them when AI features are switched on or off.",
			"",
			"## Checks",
			"",
			Object.entries(kit.checks).map(([k, v]) => `- ${k}: \`${v}\``).join("\n") || "No checks defined yet.",
			"",
		].join("\n"),
	);

	write(join(dir, "docs", "idea.md"), `# Idea\n\n${project.idea.trim() || "(not written yet)"}\n`);
	write(
		join(dir, ".factory", "project.yml"),
		stringify({ name: project.name, kit: kit.name, kit_version: kit.version, components: kit.components, checks: kit.checks, runtime: kit.runtime ?? {}, allowed_commands: kit.allowed_commands }),
	);

	return walk(dir)
		.map((f) => relative(dir, f))
		.filter((f) => !f.startsWith(".git/"))
		.sort();
}
