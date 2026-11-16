// Everything that differs from one server to the next comes from the environment
// (the repo's .env, see .env.example). Nothing here names a user, a host or a domain.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.FACTORY_HOME || join(homedir(), "factory");

export const config = {
	home,
	socket: process.env.FACTORY_SOCKET || join(home, "run", "host.sock"),
	projectsDir: join(home, "projects"),
	kitsDir: join(home, "kits"),
	worktreesDir: join(home, "worktrees"),
	deployDir: join(home, "deploy"),
	/** Kit library shipped with the repo; copied to kitsDir on first start. */
	seedKitsDir: fileURLToPath(new URL("../../../kits", import.meta.url)),
	/** GitHub account that owns created repos. Detected from `gh` when not set. */
	ghOwner: process.env.GH_OWNER || "",
	/** Folder of the gateway whose scripts/gateway.sh publishes sites: the bundled one, unless another is named. */
	gatewayDir: process.env.GATEWAY_DIR || join(home, "gateway"),
	/** Domain that apps are published under, as <name>.<domain>. Read from the gateway's own .env when not set. */
	domain: process.env.FACTORY_DOMAIN || "",
	/** Shown in the UI for "Open in VS Code": user@host of this server. */
	sshTarget: process.env.FACTORY_SSH_TARGET || "",
	/** Network shared by the gateway and the web container of every factory app. */
	edgeNetwork: process.env.FACTORY_EDGE_NETWORK || "factory-edge",
	gatewayContainer: process.env.GATEWAY_CONTAINER || "gateway-caddy",
};

export const PROJECT_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
