import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.js reads FACTORY_HOME when first imported.
process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "claudeauth-"));
const auth = await import("../dist/claudeauth.js");
const { buildEnv, classifyResult } = await import("../dist/runner.js");

const opts = { cwd: "/w", prompt: "", policy: { allow: [], deny: [] } };
const oauth = "sk-ant-oat01-" + "a".repeat(40);

test("a saved subscription token reaches runs, privately stored and never echoed", () => {
	assert.deepEqual(auth.claudeAuthEnv(), {});
	const r = auth.saveToken(`  ${oauth}\n`);
	assert.equal(r.token.kind, "oauth");
	assert.ok(!r.token.hint.includes("a".repeat(20)));
	assert.equal(statSync(join(process.env.FACTORY_HOME, "secrets", "claude-token.json")).mode & 0o777, 0o600);
	const env = buildEnv(opts, "run", { HOME: "/h", SECRET: "x" });
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, oauth);
	assert.equal(env.SECRET, undefined);
	auth.clearToken();
	assert.equal(buildEnv(opts, "run", { HOME: "/h" }).CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("an API key is passed as ANTHROPIC_API_KEY; anything else is refused", () => {
	auth.saveToken("sk-ant-api03-" + "b".repeat(40));
	assert.ok(auth.claudeAuthEnv().ANTHROPIC_API_KEY);
	auth.clearToken();
	assert.throws(() => auth.saveToken("hello"), /not a Claude token/);
});

test("a refresh race between processes is not reported as signed out", () => {
	const result = (text) => ({ is_error: true, result: text });
	assert.equal(classifyResult(result("Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh."), false), "failed");
	assert.equal(classifyResult(result("Invalid API key · Please run /login"), false), "auth_required");
});
