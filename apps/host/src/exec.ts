import { execFile } from "node:child_process";

export interface ExecResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Runs a fixed program with an argument array. Never goes through a shell. */
export function run(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(file, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			// stdout keeps its leading whitespace: `git status --porcelain` lines can start with a space.
			const code = err ? (typeof (err as any).code === "number" ? (err as any).code : null) : 0;
			resolve({ ok: !err, code, stdout: stdout.replace(/\s+$/, ""), stderr: stderr.trim() || (err && code === null ? String(err.message) : "") });
		});
	});
}
