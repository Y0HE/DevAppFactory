#!/usr/bin/env bash
# Sets up the gateway bundled with DevAppFactory and publishes the factory's UI behind a login.
# Skip this when you already run a gateway of your own and point GATEWAY_DIR at it.
#
#   ./deploy/install-gateway.sh <domain> [email-for-certificates]
#
# Apps are served as https://<name>.<domain>, so DNS for those names (or a wildcard record)
# must point at this server, and ports 80 and 443 must be free. Use "localhost" as the domain
# to try the factory on one machine: the browser will then warn about a local certificate.
# Safe to run again: it updates the gateway's own files and keeps your sites, logins and settings.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$repo/.env"
[ -f "$env_file" ] || { echo "Run deploy/install-host.sh first: it creates .env." >&2; exit 1; }

setting() { grep "^$1=" "$env_file" | tail -1 | cut -d= -f2- || true; }
ensure() { grep -q "^$1=" "$2" 2>/dev/null || echo "$1=$3" >> "$2"; }

domain="${1:-$(setting FACTORY_DOMAIN)}"
[ -n "$domain" ] || { echo "Usage: $0 <domain> [email-for-certificates]" >&2; exit 1; }
email="${2:-admin@$domain}"
factory_home="$(setting FACTORY_HOME)"
[ -n "$factory_home" ] || { echo "FACTORY_HOME is not set in .env; run deploy/install-host.sh first." >&2; exit 1; }
dir="$(setting GATEWAY_DIR)"
dir="${dir:-$factory_home/gateway}"
edge="$(setting FACTORY_EDGE_NETWORK)"
app="$(setting FACTORY_APP_NETWORK)"
container="$(setting GATEWAY_CONTAINER)"

# The gateway's own files are replaced; sites/, auth/ and .env belong to this installation and stay.
mkdir -p "$dir/sites" "$dir/auth" "$dir/scripts" "$dir/snippets"
cp "$repo/deploy/gateway/Caddyfile" "$repo/deploy/gateway/docker-compose.yml" "$repo/deploy/gateway/.gitignore" "$dir/"
cp "$repo/deploy/gateway/snippets/common.caddy" "$dir/snippets/"
cp "$repo/deploy/gateway/scripts/gateway.sh" "$dir/scripts/"
chmod +x "$dir/scripts/gateway.sh"

touch "$dir/.env"
ensure DOMAIN "$dir/.env" "$domain"
ensure ACME_EMAIL "$dir/.env" "$email"
[ -z "$edge" ] || ensure FACTORY_EDGE_NETWORK "$dir/.env" "$edge"
[ -z "$app" ] || ensure FACTORY_APP_NETWORK "$dir/.env" "$app"
[ -z "$container" ] || ensure GATEWAY_CONTAINER "$dir/.env" "$container"
ensure FACTORY_DOMAIN "$env_file" "$domain"

# The factory records every site it adds as a commit here.
if [ ! -d "$dir/.git" ]; then
	git -C "$dir" init -q -b main
	# Its own identity, so recording a site works on a server where git has none configured.
	git -C "$dir" config user.name "DevAppFactory"
	git -C "$dir" config user.email "factory@localhost"
	git -C "$dir" add -A
	git -C "$dir" commit -q -m "Set up the gateway" || true
fi

gw="$dir/scripts/gateway.sh"
if [ "$("$gw" users)" = "(none)" ]; then
	if [ -t 0 ]; then
		read -r -p "Login name for the factory UI [admin]: " user
		"$gw" passwd "${user:-admin}"
	else
		echo "No login exists yet. Create one, then run this script again:" >&2
		echo "  $gw passwd admin" >&2
		exit 1
	fi
fi

"$gw" up
"$gw" sites | grep -qx factory || "$gw" add factory factory-app:3000 --auth
echo
echo "Gateway ready in $dir. The factory UI will be at https://factory.$domain once it runs:"
echo "  docker compose up -d --build"
