// Claude Code credentials for agent runs, managed from the web UI.
//
// Interactive `claude auth login` stores a short-lived OAuth token in ~/.claude/.credentials.json that
// every Claude process on the server refreshes. Several agents running at once race on that refresh
// ("another Claude Code process is refreshing it") and runs fail. A long-lived token from
// `claude setup-token` needs no refresh, so runs get it through CLAUDE_CODE_OAUTH_TOKEN instead.
//
// The token is created here by driving `claude setup-token` in a pseudo-terminal: the UI shows the
// sign-in link, the user pastes back the code from the browser, and the token never leaves the host.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

interface StoredToken {
	kind: "oauth" | "apikey";
	value: string;
	savedAt: string;
}

const SECRETS_DIR = join(config.home, "secrets");
const TOKEN_FILE = join(SECRETS_DIR, "claude-token.json");
const OAUTH_TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/;
const API_KEY = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/;
/** setup-token tokens are valid for one year. */
const TOKEN_LIFETIME_MS = 365 * 24 * 3600 * 1000;

function readToken(): StoredToken | null {
	try {
		const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
		return t && (t.kind === "oauth" || t.kind === "apikey") && typeof t.value === "string" ? t : null;
	} catch {
		return null;
	}
}

/** Variables that give a Claude Code process the stored credential; empty when none is stored. */
export function claudeAuthEnv(): Record<string, string> {
	const t = readToken();
	if (!t) return {};
	return t.kind === "oauth" ? { CLAUDE_CODE_OAUTH_TOKEN: t.value } : { ANTHROPIC_API_KEY: t.value };
}

export function tokenInfo() {
	const t = readToken();
	if (!t) return null;
	return {
		kind: t.kind,
		savedAt: t.savedAt,
		expiresAt: t.kind === "oauth" ? new Date(Date.parse(t.savedAt) + TOKEN_LIFETIME_MS).toISOString() : undefined,
		/** Enough to recognise the token, never the token itself. */
		hint: `${t.value.slice(0, 14)}…${t.value.slice(-4)}`,
	};
}

export function saveToken(raw: unknown) {
	const value = String(raw ?? "").trim();
	const kind = OAUTH_TOKEN.test(value) ? "oauth" : API_KEY.test(value) ? "apikey" : null;
	if (!kind) throw new Error("not a Claude token: expected sk-ant-oat… (from `claude setup-token`) or sk-ant-api… (an API key)");
	mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
	chmodSync(SECRETS_DIR, 0o700);
	const stored: StoredToken = { kind, value, savedAt: new Date().toISOString() };
	writeFileSync(TOKEN_FILE, JSON.stringify(stored), { mode: 0o600 });
	chmodSync(TOKEN_FILE, 0o600);
	return { ok: true, token: tokenInfo() };
}

export function clearToken() {
	if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
	return { ok: true };
}

// --- Sign-in through `claude setup-token` ---------------------------------------------------------

interface LoginSession {
	id: string;
	child: ChildProcess;
	output: string;
	url?: string;
	timer: NodeJS.Timeout;
}

let session: LoginSession | null = null;
const SESSION_TTL_MS = 10 * 60_000;

// OSC 8 hyperlinks (ESC ] 8 ; params ; url BEL) carry the full link even when the visible text wraps.
const AUTHORIZE_URL = /https:\/\/[^\s\x07\x1b"']*\/oauth\/authorize\?[^\s\x07\x1b"']+/;
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?>=]*[A-Za-z~]|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
const TOKEN_IN_OUTPUT = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;

const plain = (s: string) => s.replace(ANSI, "").replace(/\r/g, "\n");

function endSession() {
	if (!session) return;
	clearTimeout(session.timer);
	if (session.child.exitCode === null) session.child.kill("SIGTERM");
	session = null;
}

function waitFor<T>(s: LoginSession, test: () => T | undefined, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const check = () => {
			const found = test();
			if (found !== undefined) return done(() => resolve(found));
			if (s.child.exitCode !== null || s.child.signalCode !== null) done(() => reject(new Error(lastLines(s.output) || "claude setup-token exited")));
		};
		const timer = setTimeout(() => done(() => reject(new Error(`no answer from claude setup-token: ${lastLines(s.output)}`))), timeoutMs);
		const done = (f: () => void) => {
			clearTimeout(timer);
			s.child.stdout?.off("data", check);
			s.child.off("exit", check);
			f();
		};
		s.child.stdout?.on("data", check);
		s.child.on("exit", check);
		check();
	});
}

function lastLines(output: string): string {
	return plain(output)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.includes("oauth/authorize"))
		.slice(-4)
		.join(" ")
		.replace(TOKEN_IN_OUTPUT, "[token]")
		.slice(0, 400);
}

/** Starts `claude setup-token` and returns the link the user opens to sign in. */
export async function startLogin() {
	endSession();
	// `script` gives the CLI the terminal it needs; a wide one keeps lines from wrapping.
	const child = spawn("script", ["-qfec", "stty cols 1000 rows 50; exec claude setup-token", "/dev/null"], {
		env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", TERM: "xterm-256color", BROWSER: "true" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const s: LoginSession = { id: randomUUID(), child, output: "", timer: setTimeout(() => session?.id === s.id && endSession(), SESSION_TTL_MS) };
	session = s;
	child.stdout!.on("data", (d) => (s.output += d));
	child.stderr!.on("data", (d) => (s.output += d));
	child.on("error", (err) => (s.output += `\n${err.message}`));
	child.on("exit", () => clearTimeout(s.timer));
	try {
		s.url = await waitFor(s, () => s.output.match(AUTHORIZE_URL)?.[0], 30_000);
	} catch (err) {
		endSession();
		throw err;
	}
	return { id: s.id, url: s.url };
}

/** Hands the code from the browser to `claude setup-token`, then stores the token it prints. */
export async function finishLogin(id: unknown, rawCode: unknown) {
	const code = String(rawCode ?? "").trim();
	if (!session || session.id !== id) throw new Error("this sign-in has expired; start again");
	if (!/^[A-Za-z0-9_#.~-]{10,}$/.test(code)) throw new Error("paste the whole code shown after signing in");
	const s = session;
	const from = s.output.length;
	s.child.stdin!.write(code);
	// Give the terminal UI a moment to take the pasted text before pressing Enter.
	await new Promise((r) => setTimeout(r, 300));
	s.child.stdin!.write("\r");
	try {
		const token = await waitFor(s, () => plain(s.output.slice(from)).match(TOKEN_IN_OUTPUT)?.[0], 60_000);
		return saveToken(token);
	} finally {
		endSession();
	}
}

export function cancelLogin() {
	endSession();
	return { ok: true };
}
