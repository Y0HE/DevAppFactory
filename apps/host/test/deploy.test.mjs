import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unsafeReasons } from "../dist/deploy.js";

const dir = mkdtempSync(join(tmpdir(), "deploy-"));
mkdirSync(join(dir, "public"));
const svc = (extra) => ({ services: { app: { image: "nginx", ...extra } } });

test("accepts an ordinary service with a mount inside the deploy folder", () => {
	assert.deepEqual(unsafeReasons(svc({ volumes: [{ type: "bind", source: join(dir, "public"), target: "/srv" }, { type: "volume", source: "data", target: "/data" }] }), dir), []);
});

test("refuses mounts from outside the deploy folder", () => {
	assert.match(unsafeReasons(svc({ volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }] }), dir)[0], /outside/);
	assert.match(unsafeReasons(svc({ volumes: [{ type: "bind", source: "/", target: "/host" }] }), dir)[0], /outside/);
	assert.match(unsafeReasons(svc({ volumes: [{ type: "bind", source: dir + "-other", target: "/x" }] }), dir)[0], /outside/);
});

test("refuses privileged and host-level settings", () => {
	assert.match(unsafeReasons(svc({ privileged: true }), dir)[0], /privileged/);
	assert.match(unsafeReasons(svc({ network_mode: "host" }), dir)[0], /host network/);
	assert.match(unsafeReasons(svc({ pid: "host" }), dir)[0], /namespace/);
	assert.match(unsafeReasons(svc({ cap_add: ["SYS_ADMIN"] }), dir)[0], /capabilities/);
	assert.match(unsafeReasons(svc({ devices: [{ source: "/dev/sda" }] }), dir)[0], /devices/);
});
