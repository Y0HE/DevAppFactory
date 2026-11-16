// How a project relates to the kit library: drift, promoting project changes, upgrading the project.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse, stringify } from "yaml";
import { config } from "./config.js";
import { run } from "./exec.js";
import { componentPaths, FILE_KINDS, installComponent, KINDS, loadKit, pendingExecutables, type FileKind } from "./kits.js";
import { teamComponents } from "./teams.js";
import { projectPath } from "./projects.js";

const ID = /^[a-z0-9][a-z0-9-]{0,48}$/;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? walk(join(dir, e)) : [join(dir, e)]));
}

/** True when two files, or two folders with all their files, have the same content. */
function same(a: string, b: string): boolean {
	if (!existsSync(a) || !existsSync(b)) return false;
	if (statSync(a).isDirectory() !== statSync(b).isDirectory()) return false;
	if (!statSync(a).isDirectory()) return readFileSync(a).equals(readFileSync(b));
	const list = (root: string) => walk(root).map((f) => relative(root, f)).sort();
	const [fa, fb] = [list(a), list(b)];
	return fa.length === fb.length && fa.every((f, i) => f === fb[i] && readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
}

/** Where each kind lives in a project, and how a file name maps to a component id. */
const PROJECT_DIRS: Record<FileKind, { dir: string; id: (entry: string) => string | null }> = {
	rules: { dir: ".claude/rules", id: (e) => (e.endsWith(".md") ? e.slice(0, -3) : null) },
	skills: { dir: ".claude/skills", id: (e) => e },
	agents: { dir: ".claude/agents", id: (e) => (e.endsWith(".md") ? e.slice(0, -3) : null) },
	commands: { dir: ".claude/commands", id: (e) => (e.endsWith(".md") ? e.slice(0, -3) : null) },
	workflows: { dir: ".github/workflows", id: (e) => (e.endsWith(".yml") ? e.slice(0, -4) : null) },
};

function libraryPath(kind: FileKind, id: string): string {
	const lib = join(config.kitsDir, "components", kind);
	return kind === "rules" ? join(lib, id, "rule.md") : kind === "skills" ? join(lib, id) : join(lib, `${id}.${kind === "workflows" ? "yml" : "md"}`);
}

function readMeta(dir: string): any {
	return parse(readFileSync(join(dir, ".factory", "project.yml"), "utf8")) ?? {};
}

export function kitStatus(project: string) {
	const dir = projectPath(project);
	const meta = readMeta(dir);
	let latest: number | null = null;
	try {
		latest = loadKit(meta.kit).version;
	} catch {}
	const components = FILE_KINDS.flatMap((kind) => {
		const { dir: sub, id } = PROJECT_DIRS[kind];
		const full = join(dir, sub);
		const present = existsSync(full) ? readdirSync(full).map(id).filter((x): x is string => !!x && ID.test(x)) : [];
		return present.map((cid) => {
			const lib = libraryPath(kind, cid);
			const mine = join(dir, sub, kind === "skills" ? cid : `${cid}.${kind === "workflows" ? "yml" : "md"}`);
			return { kind, id: cid, state: !existsSync(lib) ? "project-only" : same(mine, lib) ? "same" : "differs" };
		});
	});
	return { kit: meta.kit as string, version: Number(meta.kit_version ?? 0), latest, updateAvailable: latest !== null && latest > Number(meta.kit_version ?? 0), components };
}

/** Copies the project's version of a component into the library, as an uncommitted change there. */
export function promote(project: string, kind: string, id: string) {
	if (!FILE_KINDS.includes(kind as FileKind) || !ID.test(id ?? "")) throw new Error("invalid component");
	const k = kind as FileKind;
	const dir = projectPath(project);
	const mine = join(dir, PROJECT_DIRS[k].dir, k === "skills" ? id : `${id}.${k === "workflows" ? "yml" : "md"}`);
	if (!existsSync(mine)) throw new Error("the project does not have that component");
	const lib = libraryPath(k, id);
	mkdirSync(dirname(lib), { recursive: true });
	cpSync(mine, lib, { recursive: true });
	return { ok: true, path: relative(config.kitsDir, lib) };
}

/**
 * Brings a checkout of the project (a feature worktree) up to the library's kit version.
 * Refreshes enabled components and the kit record; never touches the app's own files.
 */
export async function applyUpgrade(project: string, slug: string) {
	projectPath(project);
	if (!ID.test(slug)) throw new Error("invalid feature");
	const dir = join(config.worktreesDir, project, slug);
	if (!existsSync(dir)) throw new Error("feature worktree not found");
	const meta = readMeta(dir);
	const kit = loadKit(meta.kit);
	const from = Number(meta.kit_version ?? 0);

	const enabled: Record<string, string[]> = meta.components ?? {};
	const skipped: string[] = [];
	const fromTeam = teamComponents(meta);
	for (const kind of KINDS) {
		// What the project has switched on, plus anything the kit now includes.
		const ids = [...new Set([...(enabled[kind] ?? []), ...kit.components[kind]])];
		for (const id of ids) {
			// A team's copy changes only when the team is updated, so one version of it is in the project.
			if (fromTeam.has(`${kind}/${id}`)) continue;
			try {
				componentPaths(kind, id);
				if ((await pendingExecutables({ [kind]: [id] })).length) throw new Error("uncommitted in the library");
				installComponent(dir, kind, id);
			} catch {
				skipped.push(`${kind}/${id}`);
			}
		}
		enabled[kind] = ids.filter((id) => !skipped.includes(`${kind}/${id}`)).sort();
	}
	Object.assign(meta, { kit_version: kit.version, components: enabled, checks: kit.checks, runtime: kit.runtime ?? {}, allowed_commands: kit.allowed_commands });
	writeFileSync(join(dir, ".factory", "project.yml"), stringify(meta));

	const settingsFile = join(dir, ".claude", "settings.json");
	let settings: any = {};
	try {
		settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	} catch {}
	settings.permissions = { ...(settings.permissions ?? {}), allow: kit.allowed_commands.map((c) => `Bash(${c} *)`) };
	mkdirSync(dirname(settingsFile), { recursive: true });
	writeFileSync(settingsFile, JSON.stringify(settings, null, "\t") + "\n");

	const git = (...args: string[]) => run("git", args, { cwd: dir });
	await git("add", "-A", "--", ...[".claude", ".factory", ".github", ".mcp.json"].filter((path) => existsSync(join(dir, path))));
	const committed = (await git("commit", "-q", "-m", `Upgrade kit ${kit.name} from version ${from} to ${kit.version}`)).ok;
	return { ok: true, from, to: kit.version, changed: committed, skipped };
}
