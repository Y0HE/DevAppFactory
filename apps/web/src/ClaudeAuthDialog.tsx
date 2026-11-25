import { useEffect, useState, type FormEvent } from "react";
import { api, type ClaudeToken } from "./api";

type Step = { kind: "idle" } | { kind: "starting" } | { kind: "code"; id: string; url: string } | { kind: "done"; token: ClaudeToken };

/**
 * Gives agent runs a long-lived Claude token without opening a shell on the server:
 * the host runs `claude setup-token`, the user signs in through the link and pastes the code back.
 */
export function ClaudeAuthDialog({ token, onClose }: { token: ClaudeToken | null; onClose: () => void }) {
	const [step, setStep] = useState<Step>({ kind: "idle" });
	const [code, setCode] = useState("");
	const [pasted, setPasted] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	});

	function close() {
		if (step.kind === "code") api.claudeLoginCancel().catch(() => {});
		onClose();
	}

	async function act(f: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await f();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	const start = () =>
		act(async () => {
			setStep({ kind: "starting" });
			try {
				const r = await api.claudeLogin();
				setStep({ kind: "code", ...r });
			} catch (e) {
				setStep({ kind: "idle" });
				throw e;
			}
		});

	const finish = (e: FormEvent) => {
		e.preventDefault();
		if (step.kind !== "code") return;
		act(async () => {
			const r = await api.claudeLoginFinish(step.id, code);
			setStep({ kind: "done", token: r.token });
		});
	};

	const savePasted = (e: FormEvent) => {
		e.preventDefault();
		act(async () => {
			const r = await api.claudeSaveToken(pasted);
			setPasted("");
			setStep({ kind: "done", token: r.token });
		});
	};

	const remove = () =>
		act(async () => {
			await api.claudeClearToken();
			onClose();
		});

	const current = step.kind === "done" ? step.token : token;

	return (
		<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="claude-auth-title">
			<div className="dialog">
				<h2 id="claude-auth-title">Connect Claude</h2>
				<p className="muted">
					Agent runs use a long-lived (1-year) token instead of the server's interactive login, so several agents can run at once without failing on
					token refresh. The token stays on the server.
				</p>

				{current && (
					<p>
						{step.kind === "done" ? "Saved. " : ""}
						Using {current.kind === "oauth" ? "a subscription token" : "an API key"} <code>{current.hint}</code>, saved {new Date(current.savedAt).toLocaleDateString()}
						{current.expiresAt ? `, valid until about ${new Date(current.expiresAt).toLocaleDateString()}` : ""}.
					</p>
				)}

				{step.kind === "code" ? (
					<form className="dialog-step" onSubmit={finish}>
						<p>
							1. <a href={step.url} target="_blank" rel="noreferrer noopener">Open the Claude sign-in page</a> and approve access.
						</p>
						<label>
							2. Paste the code it shows
							<input value={code} onChange={(e) => setCode(e.target.value)} autoFocus required disabled={busy} autoComplete="off" spellCheck={false} />
						</label>
						<div className="actions">
							<button type="button" onClick={close} disabled={busy}>
								Cancel
							</button>
							<button className="primary" disabled={busy || !code.trim()}>
								{busy ? "Creating token…" : "Create token"}
							</button>
						</div>
					</form>
				) : step.kind !== "done" ? (
					<>
						<div className="actions" style={{ justifyContent: "flex-start" }}>
							<button className="primary" onClick={start} disabled={busy}>
								{step.kind === "starting" ? "Preparing sign-in…" : current ? "Replace with a new token" : "Sign in with Claude"}
							</button>
						</div>
						<details>
							<summary>Or paste a token</summary>
							<form className="dialog-step" onSubmit={savePasted}>
								<label>
									Token
									<input
										type="password"
										value={pasted}
										onChange={(e) => setPasted(e.target.value)}
										placeholder="sk-ant-oat01-… or sk-ant-api03-…"
										disabled={busy}
										autoComplete="off"
									/>
									<small className="muted">
										From <code>claude setup-token</code> run on any computer, or an Anthropic API key (billed per use).
									</small>
								</label>
								<div className="actions">
									<button disabled={busy || !pasted.trim()}>Save token</button>
								</div>
							</form>
						</details>
					</>
				) : null}

				{error && <p className="error">{error}</p>}

				<div className="actions">
					{current && step.kind !== "code" && (
						<button onClick={remove} disabled={busy} title="Runs fall back to the server's interactive login">
							Remove token
						</button>
					)}
					{step.kind !== "code" && (
						<button className={step.kind === "done" ? "primary" : ""} onClick={close} disabled={busy}>
							{step.kind === "done" ? "Done" : "Close"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
