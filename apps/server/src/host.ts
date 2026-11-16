// Client for factory-host over its Unix socket.
import { request } from "node:http";

export class HostUnavailable extends Error {}

export type HostClient = ReturnType<typeof hostClient>;

export function hostClient(socketPath: string) {
	function call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 16 * 60_000): Promise<T> {
		return new Promise((resolve, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const req = request(
				{ socketPath, path, method, timeout: timeoutMs, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
				(res) => {
					let data = "";
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => {
						try {
							const json = JSON.parse(data);
							if ((res.statusCode ?? 500) >= 400) reject(new Error(json.error ?? `host error ${res.statusCode}`));
							else resolve(json as T);
						} catch {
							reject(new Error("invalid response from factory-host"));
						}
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error("factory-host timed out")));
			req.on("error", (err: NodeJS.ErrnoException) =>
				reject(err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "EACCES" ? new HostUnavailable(`factory-host is not reachable (${err.code})`) : err),
			);
			req.end(payload);
		});
	}
	/** Follows a line-delimited JSON stream until the host closes it. */
	function stream(path: string, onLine: (obj: any) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			const req = request({ socketPath, path, method: "GET" }, (res) => {
				if ((res.statusCode ?? 500) >= 400) {
					res.resume();
					return reject(new Error(`host error ${res.statusCode}`));
				}
				let buffer = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					buffer += chunk;
					let nl: number;
					while ((nl = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, nl);
						buffer = buffer.slice(nl + 1);
						if (line.trim()) onLine(JSON.parse(line));
					}
				});
				res.on("end", resolve);
				res.on("error", reject);
			});
			req.on("error", reject);
			req.end();
		});
	}
	return { stream, get: <T>(path: string) => call<T>("GET", path), post: <T>(path: string, body: unknown) => call<T>("POST", path, body) };
}
