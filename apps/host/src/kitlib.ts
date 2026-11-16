// The kit library as an editable git repository: browse, edit, create, validate, review, commit.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parse } from "yaml";
import { config } from "./config.js";
import { run } from "./exec.js";
import { hookEntries, mcpDefinition } from "./kits.js";

export const KINDS = ["agents", "rules", "skills", "commands", "hooks", "mcp", "workflows", "scaffolds"] as const;
type Kind = (typeof KINDS)[number];
const ID = /^[a-z0-9][a-z0-9-]{0,48}$/;
const MAX_FILE = 300_000;

const git = (...args: string[]) => run("git", args, { cwd: config.kitsDir, timeoutMs: 60_000 });

/** Resolves a library-relative path, refusing anything outside kits/, teams/ and components/. */
function resolvePath(rel: string): string {
	if (typeof rel !== "string" || !/^(kits|teams|components)\/[A-Za-z0-9._\/-]+$/.test(rel) || rel.split("/").some((part) => part === ".." || part === "." || part === "")) {
		throw new Error("invalid library path");
	}
	return join(config.kitsDir, rel);
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

function frontmatter(text: string): Record<string, unknown> | null {
	const m = text.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	try {
		return parse(m[1]) ?? {};
	} catch {
		return null;
	}
}

/** Entries of one component kind: `path` is the file or folder that makes up the item. */
function items(kind: Kind): { id: string; path: string; dir: boolean }[] {
	const base = join(config.kitsDir, "components", kind);
	if (!existsSync(base)) return [];
	return readdirSync(base)
		.map((entry) => ({ id: entry.replace(/\.(md|yml|yaml|json)$/, ""), path: `components/${kind}/${entry}`, dir: statSync(join(base, entry)).isDirectory() }))
		.filter((i) => ID.test(i.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}

export async function tree() {
	const kitsDir = join(config.kitsDir, "kits");
	const kits = (existsSync(kitsDir) ? readdirSync(kitsDir) : [])
		.filter((id) => ID.test(id) && existsSync(join(kitsDir, id, "kit.yml")))
		.map((id) => {
			let meta: any = {};
			try {
				meta = parse(readFileSync(join(kitsDir, id, "kit.yml"), "utf8")) ?? {};
			} catch {}
			return { id, path: `kits/${id}`, dir: true, version: Number(meta.version ?? 0), description: String(meta.description ?? "") };
		});
	const teamsDir = join(config.kitsDir, "teams");
	const teams = (existsSync(teamsDir) ? readdirSync(teamsDir) : [])
		.filter((id) => ID.test(id) && existsSync(join(teamsDir, id, "team.yml")))
		.sort()
		.map((id) => {
			let meta: any = {};
			try {
				meta = parse(readFileSync(join(teamsDir, id, "team.yml"), "utf8")) ?? {};
			} catch {}
			return { id, path: `teams/${id}`, dir: true, version: Number(meta.version ?? 0), description: String(meta.description ?? "") };
		});
	return { kits, teams, components: Object.fromEntries(KINDS.map((k) => [k, items(k)])), pending: (await pending()).changes.length };
}

export function files(rel: string) {
	const full = resolvePath(rel);
	if (!existsSync(full)) throw new Error("not found");
	if (!statSync(full).isDirectory()) return [rel];
	return walk(full)
		.map((f) => relative(config.kitsDir, f).split(sep).join("/"))
		.sort();
}

export function read(rel: string) {
	const full = resolvePath(rel);
	if (!existsSync(full) || statSync(full).isDirectory()) throw new Error("file not found");
	if (statSync(full).size > MAX_FILE) throw new Error("file is too large to edit here");
	return { path: rel, content: readFileSync(full, "utf8") };
}

export function write(rel: string, content: string) {
	const full = resolvePath(rel);
	if (rel.split("/").length < 3) throw new Error("files live inside a kit, team or component");
	if (typeof content !== "string" || content.length > MAX_FILE) throw new Error("content is missing or too large");
	if (existsSync(full) && statSync(full).isDirectory()) throw new Error("that path is a folder");
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	return { ok: true };
}

export function remove(rel: string) {
	const full = resolvePath(rel);
	if (rel.split("/").length < (rel.startsWith("components/") ? 3 : 2)) throw new Error("only a kit, a team, a component or a file inside one can be deleted");
	rmSync(full, { recursive: true, force: true });
	return { ok: true };
}

const TEMPLATES: Record<Exclude<Kind, "scaffolds">, (id: string) => { path: string; content: string }> = {
	rules: (id) => ({ path: `components/rules/${id}/rule.md`, content: `# ${id}\n\n- Describe the rule the agent must follow.\n` }),
	skills: (id) => ({ path: `components/skills/${id}/SKILL.md`, content: `---\nname: ${id}\ndescription: When to use this skill, in one sentence.\n---\n\n# ${id}\n\nSteps the agent follows.\n` }),
	agents: (id) => ({ path: `components/agents/${id}.md`, content: `---\nname: ${id}\ndescription: When this subagent should be used.\ntools: Read, Grep, Glob\n---\n\nYou are a subagent. Describe its job and how it reports.\n` }),
	commands: (id) => ({ path: `components/commands/${id}.md`, content: `---\ndescription: What this command does, in one sentence.\n---\n\nInstructions the agent follows when someone runs /${id}. $ARGUMENTS holds what was typed after the command.\n` }),
	workflows: (id) => ({ path: `components/workflows/${id}.yml`, content: `name: ${id}\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "replace with real checks"\n` }),
	hooks: (id) => ({ path: `components/hooks/${id}/hook.json`, content: `{\n\t"event": "PostToolUse",\n\t"matcher": "Edit|Write",\n\t"command": "\\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/${id}/run.sh"\n}\n` }),
	mcp: (id) => ({ path: `components/mcp/${id}.json`, content: `{\n\t"command": "npx",\n\t"args": ["-y", "replace-with-mcp-server"]\n}\n` }),
};

export function create(type: string, id: string, from?: string) {
	if (!ID.test(id ?? "")) throw new Error("use lowercase letters, digits and dashes for the name");
	if (type === "kit") {
		const dest = join(config.kitsDir, "kits", id);
		if (existsSync(dest)) throw new Error(`kit ${id} already exists`);
		if (from) {
			if (!ID.test(from) || !existsSync(join(config.kitsDir, "kits", from))) throw new Error("kit to copy not found");
			cpSync(join(config.kitsDir, "kits", from), dest, { recursive: true });
			const file = join(dest, "kit.yml");
			writeFileSync(file, readFileSync(file, "utf8").replace(/^name:.*$/m, `name: ${id}`).replace(/^version:.*$/m, "version: 1"));
		} else {
			mkdirSync(dest, { recursive: true });
			writeFileSync(
				join(dest, "kit.yml"),
				`name: ${id}\nversion: 1\ndescription: What this kit is for.\nscaffold: base\ncomponents:\n  rules: [factory-workflow, docker-first]\n  skills: []\n  agents: []\n  hooks: []\n  mcp: []\n  workflows: []\nchecks: {}\nruntime:\n  port: 80\n  health: /\nallowed_commands: ["docker compose", make, git]\n`,
			);
		}
		return { path: `kits/${id}/kit.yml` };
	}
	if (type === "team") {
		const dest = join(config.kitsDir, "teams", id);
		if (existsSync(dest)) throw new Error(`team ${id} already exists`);
		const first = items("agents")[0]?.id;
		if (!first) throw new Error("create a subagent first: a team needs at least one");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "team.yml"), `name: ${id}\nversion: 1\ndescription: What this team is for.\ncomponents:\n  agents: [${first}]\n`);
		return { path: `teams/${id}/team.yml` };
	}
	if (type === "scaffolds") {
		const dest = join(config.kitsDir, "components", "scaffolds", id);
		if (existsSync(dest)) throw new Error(`scaffold ${id} already exists`);
		const source = join(config.kitsDir, "components", "scaffolds", from && ID.test(from) ? from : "base");
		if (!existsSync(source)) throw new Error("scaffold to copy not found");
		cpSync(source, dest, { recursive: true });
		return { path: `components/scaffolds/${id}/docker-compose.yml` };
	}
	const template = TEMPLATES[type as Exclude<Kind, "scaffolds">];
	if (!template) throw new Error(`unknown type: ${type}`);
	const { path, content } = template(id);
	if (existsSync(join(config.kitsDir, path))) throw new Error(`${type} ${id} already exists`);
	write(path, content);
	return { path };
}

/** Problems that would make kits or components unusable. An empty list means the library is sound. */
export function validate(): string[] {
	const errors: string[] = [];
	const has = (kind: Kind, id: string) => items(kind).some((i) => i.id === id);
	const text = (rel: string) => readFileSync(join(config.kitsDir, rel), "utf8");

	for (const i of items("rules")) {
		const file = `${i.path}/rule.md`;
		if (!i.dir || !existsSync(join(config.kitsDir, file))) errors.push(`${i.path}: a rule is a folder with rule.md`);
		else if (!text(file).trim()) errors.push(`${file}: is empty`);
	}
	for (const i of items("agents")) {
		const fm = i.dir ? null : frontmatter(text(i.path));
		if (!fm?.name || !fm?.description) errors.push(`${i.path}: needs frontmatter with name and description`);
	}
	for (const i of items("skills")) {
		const file = `${i.path}/SKILL.md`;
		const fm = i.dir && existsSync(join(config.kitsDir, file)) ? frontmatter(text(file)) : null;
		if (!fm?.name || !fm?.description) errors.push(`${i.path}: needs SKILL.md with name and description frontmatter`);
	}
	for (const i of items("workflows")) {
		try {
			const doc = parse(text(i.path));
			if (!doc || typeof doc !== "object" || !("jobs" in doc)) errors.push(`${i.path}: a workflow needs jobs`);
		} catch (err) {
			errors.push(`${i.path}: invalid YAML (${(err as Error).message.split("\n")[0]})`);
		}
	}
	for (const i of items("commands")) {
		if (i.dir || !text(i.path).trim()) errors.push(`${i.path}: a command is a Markdown file with instructions`);
	}
	for (const i of items("hooks")) {
		const file = `${i.path}/hook.json`;
		try {
			if (!i.dir) throw new Error("a hook is a folder with hook.json");
			hookEntries(JSON.parse(text(file)));
		} catch (err) {
			errors.push(`${file}: ${(err as Error).message.split("\n")[0]}`);
		}
	}
	for (const i of items("mcp")) {
		try {
			mcpDefinition(JSON.parse(text(i.path)));
		} catch (err) {
			errors.push(`${i.path}: ${(err as Error).message.split("\n")[0]}`);
		}
	}
	const teamsDir = join(config.kitsDir, "teams");
	for (const id of existsSync(teamsDir) ? readdirSync(teamsDir).filter((d) => ID.test(d)) : []) {
		const file = `teams/${id}/team.yml`;
		if (!existsSync(join(config.kitsDir, file))) {
			errors.push(`teams/${id}: has no team.yml`);
			continue;
		}
		let team: any;
		try {
			team = parse(text(file)) ?? {};
		} catch (err) {
			errors.push(`${file}: invalid YAML (${(err as Error).message.split("\n")[0]})`);
			continue;
		}
		if (!Number.isInteger(team.version) || team.version < 1) errors.push(`${file}: version must be a whole number, 1 or higher`);
		const members = team.components?.agents;
		if (!Array.isArray(members) || members.length === 0) errors.push(`${file}: a team needs at least one subagent under components.agents`);
		for (const kind of ["agents", "rules", "skills", "commands", "hooks", "mcp", "workflows"] as const) {
			const list = team.components?.[kind] ?? [];
			if (!Array.isArray(list)) errors.push(`${file}: components.${kind} must be a list`);
			else for (const ref of list) if (!has(kind, ref)) errors.push(`${file}: ${kind} "${ref}" does not exist`);
		}
		if (team.lead !== undefined && !(Array.isArray(members) && members.includes(team.lead))) errors.push(`${file}: lead "${team.lead}" is not one of the team's subagents`);
	}
	const kitsDir = join(config.kitsDir, "kits");
	for (const id of existsSync(kitsDir) ? readdirSync(kitsDir).filter((d) => ID.test(d)) : []) {
		const file = `kits/${id}/kit.yml`;
		if (!existsSync(join(config.kitsDir, file))) {
			errors.push(`kits/${id}: has no kit.yml`);
			continue;
		}
		let kit: any;
		try {
			kit = parse(text(file)) ?? {};
		} catch (err) {
			errors.push(`${file}: invalid YAML (${(err as Error).message.split("\n")[0]})`);
			continue;
		}
		if (!Number.isInteger(kit.version) || kit.version < 1) errors.push(`${file}: version must be a whole number, 1 or higher`);
		if (kit.scaffold && !has("scaffolds", kit.scaffold)) errors.push(`${file}: scaffold "${kit.scaffold}" does not exist`);
		for (const kind of ["rules", "skills", "agents", "commands", "workflows", "hooks", "mcp"] as const) {
			const list = kit.components?.[kind] ?? [];
			if (!Array.isArray(list)) errors.push(`${file}: components.${kind} must be a list`);
			else for (const ref of list) if (!has(kind, ref)) errors.push(`${file}: ${kind} "${ref}" does not exist`);
		}
		if (kit.checks && typeof kit.checks !== "object") errors.push(`${file}: checks must be a map of name to command`);
		if (kit.allowed_commands && !Array.isArray(kit.allowed_commands)) errors.push(`${file}: allowed_commands must be a list`);
	}
	return errors;
}

/**
 * Files of the seed library (shipped with the factory in `kits/`) that the library does not have,
 * or has with other content. The seed is only copied on first start, so this is how later
 * additions to it are found. A file the library has and the seed lacks is not reported.
 */
export function seedStatus(): { files: { path: string; state: "new" | "differs" }[] } {
	const root = config.seedKitsDir;
	if (!existsSync(root)) return { files: [] };
	const files: { path: string; state: "new" | "differs" }[] = [];
	for (const full of walk(root)) {
		const path = relative(root, full).split(sep).join("/");
		if (path.startsWith(".git/")) continue;
		const mine = join(config.kitsDir, path);
		if (!existsSync(mine)) files.push({ path, state: "new" });
		else if (statSync(mine).isDirectory() || !readFileSync(full).equals(readFileSync(mine))) files.push({ path, state: "differs" });
	}
	return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Copies the chosen seed files into the library, as uncommitted changes there. Nothing is deleted. */
export function pullSeed(paths: unknown) {
	if (!Array.isArray(paths) || paths.length === 0) throw new Error("choose at least one file to copy");
	// Only paths the comparison itself reported are accepted, so nothing outside the seed can be named.
	const known = new Map(seedStatus().files.map((f) => [f.path, f.state]));
	const unknown = paths.filter((p) => typeof p !== "string" || !known.has(p));
	if (unknown.length) throw new Error(`not a seed file that differs from the library: ${unknown.slice(0, 3).join(", ")}`);
	for (const path of paths as string[]) {
		const dest = join(config.kitsDir, path);
		if (existsSync(dest) && statSync(dest).isDirectory()) throw new Error(`${path} is a folder in the library; delete it there first`);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(config.seedKitsDir, path), dest);
	}
	return { ok: true, copied: paths.length, ...seedStatus() };
}

/** Uncommitted changes in the library, as a file list and one diff. */
export async function pending() {
	await git("add", "-A", "-N", "."); // so new files appear in the diff
	const status = await git("status", "--porcelain");
	const diff = await git("diff", "--no-color", "HEAD");
	return {
		changes: status.stdout ? status.stdout.split("\n").map((l) => ({ code: l.slice(0, 2).trim() || "M", path: l.slice(3) })) : [],
		diff: diff.stdout.slice(0, 400_000),
		errors: validate(),
	};
}

export async function commit(message: string) {
	const errors = validate();
	if (errors.length) throw new Error(`Fix these before committing: ${errors.join("; ")}`);
	await git("add", "-A");
	const res = await git("commit", "-q", "-m", String(message || "Update kit library").slice(0, 200));
	if (!res.ok) throw new Error(res.stdout || res.stderr || "nothing to commit");
	return { ok: true };
}

export async function discard() {
	await git("reset", "-q", "--hard", "HEAD");
	await git("clean", "-fdq");
	return { ok: true };
}
