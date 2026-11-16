#!/usr/bin/env bash
# Build factory-host and (re)start it as a systemd user service.
# Creates .env on first run and adds any required setting that is missing; never changes a value you set.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$repo/.env"

node_bin="$(command -v node)" || { echo "node is required (version 18 or later)" >&2; exit 1; }

# Adds KEY=value to .env unless the key is already there.
ensure() {
	grep -q "^$1=" "$env_file" 2>/dev/null || echo "$1=$2" >> "$env_file"
}
[ -f "$env_file" ] || (umask 077; : > "$env_file")
chmod 600 "$env_file"
# Key that encrypts the environment variables stored for deployments. Keep it: losing it makes them unreadable.
ensure FACTORY_SECRET_KEY "$(openssl rand -hex 32)"
ensure FACTORY_HOME "$HOME/factory"
ensure FACTORY_UID "$(id -u)"
ensure FACTORY_GID "$(id -g)"
factory_home="$(grep '^FACTORY_HOME=' "$env_file" | tail -1 | cut -d= -f2-)"

cd "$repo/apps/host"
npm install --no-audit --no-fund
npm run build

mkdir -p ~/.config/systemd/user "$factory_home/data" "$factory_home/run"
sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_bin|g" "$repo/deploy/factory-host.service" > ~/.config/systemd/user/factory-host.service
systemctl --user daemon-reload
systemctl --user enable factory-host >/dev/null
systemctl --user restart factory-host
systemctl --user --no-pager status factory-host | head -5
loginctl show-user "$USER" -p Linger | grep -q yes || echo "note: run 'sudo loginctl enable-linger $USER' so the service keeps running after logout and starts at boot"
