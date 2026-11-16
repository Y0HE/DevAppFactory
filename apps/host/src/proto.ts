// Prototype driver: runs scenarios against a real Claude Code session and prints what happened.
// Usage: node dist/proto.js <scenario> [workdir]
//   basic      one prompt, stream events, print the result
//   followup   send a second message while the first turn is running
//   interrupt  start a long task, interrupt it after a few seconds
//   resume     run one turn, then resume the same session in a new process
//   policy     ask the agent to do allowed and forbidden things, report what was denied
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun, type PermissionPolicy, type Run, type RunEvent } from "./runner.js";

const policy: PermissionPolicy = {
	allow: ["Bash(git status*)", "Bash(git add *)", "Bash(git commit *)", "Bash(git diff*)", "Bash(ls*)", "Bash(docker compose *)"],
	deny: ["Bash(git push*)", "Bash(sudo *)"],
};
const model = process.env.PROTO_MODEL ?? "haiku";

function workdir(arg?: string): string {
	if (arg) return arg;
	const dir = mkdtempSync(join(tmpdir(), "factory-proto-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# proto\n");
	return dir;
}

function describe(e: RunEvent): string {
	const p = e.payload as any;
	if (e.type === "system") return `system/${p.subtype}${p.session_id ? ` session=${p.session_id}` : ""}`;
	if (e.type === "assistant" || e.type === "user") {
		const parts = Array.isArray(p.message?.content) ? p.message.content : [{ type: "text", text: String(p.message?.content) }];
		return parts
			.map((c: any) => {
				if (c.type === "text") return `${e.type}: ${c.text.slice(0, 160)}`;
				if (c.type === "tool_use") return `tool_use ${c.name} ${JSON.stringify(c.input).slice(0, 140)}`;
				if (c.type === "tool_result") return `tool_result${c.is_error ? " (error)" : ""} ${JSON.stringify(c.content).slice(0, 140)}`;
				return c.type;
			})
			.join(" | ");
	}
	if (e.type === "result") return `result/${p.subtype} terminal=${p.terminal_reason} turns=${p.num_turns} denials=${p.permission_denials?.length ?? 0}`;
	return `${e.type}: ${JSON.stringify(p).slice(0, 160)}`;
}

function watch(run: Run): Run {
	const t0 = Date.now();
	run.on("event", (e: RunEvent) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s #${e.seq}] ${describe(e)}`));
	return run;
}

async function finish(run: Run) {
	const res = await run.done;
	console.log(`=> status=${res.status} exit=${res.exitCode} session=${res.sessionId} tokens=${JSON.stringify(res.usage)}`);
	return res;
}

const scenarios: Record<string, (dir: string) => Promise<void>> = {
	async basic(dir) {
		await finish(watch(startRun({ cwd: dir, model, policy, prompt: "Create a file hello.txt containing the word hello. Then say done." })));
		console.log(`hello.txt exists: ${existsSync(join(dir, "hello.txt"))}`);
	},
	async followup(dir) {
		const run = watch(startRun({ cwd: dir, model, policy, prompt: "Create a.txt containing A." }));
		setTimeout(() => run.send("Now also create b.txt containing B."), 1500);
		await finish(run);
		console.log(`a.txt: ${existsSync(join(dir, "a.txt"))}, b.txt: ${existsSync(join(dir, "b.txt"))}`);
	},
	async interrupt(dir) {
		const run = watch(startRun({ cwd: dir, model, policy, prompt: "Write 30 separate files n1.txt to n30.txt, one tool call each, each containing its number." }));
		setTimeout(() => (console.log("  -- interrupting"), run.interrupt()), 8000);
		await finish(run);
	},
	async resume(dir) {
		const first = await finish(watch(startRun({ cwd: dir, model, policy, prompt: "Remember the code word: marmalade. Reply only: ok" })));
		const second = await finish(watch(startRun({ cwd: dir, model, policy, resumeSessionId: first.sessionId, prompt: "What was the code word? Reply with just the word." })));
		console.log(`resumed answer: ${second.text}`);
	},
	async policy(dir) {
		writeFileSync(join(dir, ".env"), "SECRET=1\n");
		const prompt = [
			"Do each of these steps in order and report for each whether it worked or was denied. Do not retry denied steps.",
			"1. Write inside.txt in the current directory.",
			"2. Read the file /etc/hostname.",
			"3. Read the file .env in the current directory.",
			"4. Run: git status",
			"5. Run: git push origin main",
			"6. Run: curl -s https://example.com",
			"7. Write the file /tmp/factory-proto-outside.txt",
		].join("\n");
		const res = await finish(watch(startRun({ cwd: dir, model, policy, prompt })));
		console.log(res.text);
		console.log(`inside.txt: ${existsSync(join(dir, "inside.txt"))}, outside: ${existsSync("/tmp/factory-proto-outside.txt")}`);
	},
	async bash(dir) {
		writeFileSync(join(dir, ".env"), "SECRET=1\n");
		const prompt = [
			"Run each of these Bash commands exactly as written, one tool call each, and report for each whether it worked or was denied. Do not retry or rephrase denied commands.",
			"1. cat /etc/hostname",
			"2. cat .env",
			"3. printf x > /tmp/factory-proto-bash-outside.txt",
			"4. printf x > bash-inside.txt",
			"5. ls /home",
		].join("\n");
		const res = await finish(watch(startRun({ cwd: dir, model, policy, prompt })));
		console.log(res.text);
		console.log(`bash-inside: ${existsSync(join(dir, "bash-inside.txt"))}, bash-outside: ${existsSync("/tmp/factory-proto-bash-outside.txt")}`);
	},
};

const [name, dirArg] = process.argv.slice(2);
if (!name || !scenarios[name]) {
	console.error(`usage: node dist/proto.js <${Object.keys(scenarios).join("|")}> [workdir]`);
	process.exit(2);
}
const dir = workdir(dirArg);
console.log(`scenario=${name} workdir=${dir} model=${model}`);
await scenarios[name](dir);
