// Reading and committing the project documents the spec and plan phases produce.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { commitAndSync } from "./git.js";
import { projectPath } from "./projects.js";

const DOC = /^docs\/[A-Za-z0-9][A-Za-z0-9._-]*\.(md|json)$/;

export function readDoc(project: string, path: string) {
	if (!DOC.test(path)) throw new Error("only .md and .json files directly under docs/ can be read");
	const file = join(projectPath(project), path);
	if (!existsSync(file)) return { exists: false, path };
	if (statSync(file).size > 300_000) throw new Error("document is too large");
	return { exists: true, path, content: readFileSync(file, "utf8") };
}

export async function commitDocs(project: string, paths: string[], message: string) {
	if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && DOC.test(p))) throw new Error("invalid document paths");
	const dir = projectPath(project);
	const missing = paths.filter((p) => !existsSync(join(dir, p)));
	if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
	return commitAndSync(dir, paths, String(message || "Update project documents").slice(0, 200));
}
