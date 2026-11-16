#!/usr/bin/env bash
# Manages the gateway bundled with DevAppFactory. The factory calls `add`, `remove` and `reload`;
# the other commands are for you. Run without arguments for the list.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
	cat <<'TXT'
Usage: gateway.sh <command>

  up                     start the gateway (creates its Docker networks when missing)
  down                   stop it
  status                 container state and the sites it serves
  logs                   follow the gateway's log
  reload                 check the configuration and apply it
  validate               check the configuration only

  add <site> <host:port> [network] [--auth]
                         serve https://<site>.<DOMAIN> from a container, optionally behind a login
  remove <site>          stop serving a site
  sites                  list the sites

  passwd <user>          create a login or change its password (asks for the password)
  unpasswd <user>        delete a login
  users                  list the logins
TXT
}

[ -f .env ] || { echo "gateway: .env is missing here; run deploy/install-gateway.sh from the DevAppFactory repository" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
CADDY="${GATEWAY_CONTAINER:-gateway-caddy}"
EDGE="${FACTORY_EDGE_NETWORK:-factory-edge}"
APP="${FACTORY_APP_NETWORK:-devappfactory-network}"
CONF=/etc/caddy/Caddyfile
NAME='^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
mkdir -p sites auth

die() { echo "gateway: $*" >&2; exit 1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$CADDY" 2>/dev/null)" = true ]; }
caddy() { docker compose exec -T caddy caddy "$@"; }

validate() {
	if running; then
		caddy validate --config "$CONF" >/dev/null 2>&1 || { caddy validate --config "$CONF" 2>&1 | tail -5 >&2; return 1; }
	fi
}

reload() {
	running || return 0 # the files are read when it starts
	validate || die "the configuration is not valid, so nothing was applied"
	caddy reload --config "$CONF" >/dev/null 2>&1 || die "reload failed; see: gateway.sh logs"
}

# Rewrites auth/users.caddy from auth/users (one "name hash" per line).
write_users() {
	if [ -s auth/users ]; then
		{ echo "basic_auth {"; sed 's/^/\t/' auth/users; echo "}"; } > auth/users.caddy
	else
		rm -f auth/users.caddy
	fi
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
	up)
		for net in "$EDGE" "$APP"; do
			docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
		done
		docker compose up -d
		;;
	down) docker compose down ;;
	status)
		if running; then echo "running ($CADDY), domain $DOMAIN"; else echo "not running"; fi
		ls -1 sites 2>/dev/null | sed -n 's/\.caddy$//p' | sed "s/\$/.$DOMAIN/"
		;;
	logs) docker logs -f --tail 100 "$CADDY" ;;
	validate) validate && echo "ok" ;;
	reload) reload ;;
	sites) ls -1 sites 2>/dev/null | sed -n 's/\.caddy$//p' ;;
	add)
		site="" upstream="" auth=0
		for arg in "$@"; do
			case "$arg" in
				--auth) auth=1 ;;
				*) if [ -z "$site" ]; then site="$arg"; elif [ -z "$upstream" ]; then upstream="$arg"; else network="$arg"; fi ;;
			esac
		done
		[[ "$site" =~ $NAME ]] || die "site must be lowercase letters, digits and dashes"
		[[ "$upstream" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[0-9]{1,5}$ ]] || die "upstream must be host:port"
		# This gateway joins two fixed networks; it does not rewire itself for others.
		if [ -n "${network:-}" ] && [ "$network" != "$EDGE" ] && [ "$network" != "$APP" ]; then
			die "this gateway only reaches containers on the networks $EDGE and $APP"
		fi
		[ -e "sites/$site.caddy" ] && die "site $site already exists; remove it first"
		[ "$auth" = 1 ] && [ ! -s auth/users ] && die "create a login first: gateway.sh passwd <user>"
		{
			echo "$site.{\$DOMAIN} {"
			printf '\timport secure_headers\n\timport compress\n\timport down_page\n'
			[ "$auth" = 1 ] && printf '\timport basicauth\n'
			printf '\treverse_proxy %s\n}\n' "$upstream"
		} > "sites/$site.caddy"
		if ! validate; then
			rm -f "sites/$site.caddy"
			die "the site was not added, because the configuration would not load with it"
		fi
		reload
		echo "added https://$site.$DOMAIN -> $upstream$([ "$auth" = 1 ] && echo ' (login required)')"
		;;
	remove)
		site="${1:-}"
		[[ "$site" =~ $NAME ]] || die "site must be lowercase letters, digits and dashes"
		[ -e "sites/$site.caddy" ] || die "no site named $site"
		rm -f "sites/$site.caddy"
		reload
		echo "removed $site"
		;;
	passwd)
		user="${1:-}"
		[[ "$user" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "user name: letters, digits, dot, dash and underscore"
		if [ -t 0 ]; then
			read -r -s -p "Password for $user: " password; echo
			read -r -s -p "Again: " again; echo
			[ "$password" = "$again" ] || die "the two entries differ"
		else
			read -r password # from a pipe, for scripts
		fi
		[ "${#password}" -ge 8 ] || die "use at least 8 characters"
		# The password goes in on standard input, so it never shows in the process list.
		hash="$(printf '%s\n' "$password" | docker run --rm -i caddy:2 caddy hash-password 2>/dev/null | tail -1)"
		[[ "$hash" == \$2* ]] || die "could not hash the password (is Docker running?)"
		touch auth/users
		chmod 600 auth/users
		{ grep -v "^$user " auth/users || true; echo "$user $hash"; } > auth/users.tmp
		mv auth/users.tmp auth/users
		write_users
		reload
		echo "login $user saved"
		;;
	unpasswd)
		user="${1:-}"
		[ -n "$user" ] && grep -q "^$user " auth/users 2>/dev/null || die "no login named $user"
		remaining="$(grep -vc "^$user " auth/users || true)"
		if [ "$remaining" = 0 ] && grep -lqs 'import basicauth' sites/*.caddy; then
			die "$user is the last login and some sites require one; add another login first"
		fi
		{ grep -v "^$user " auth/users || true; } > auth/users.tmp
		mv auth/users.tmp auth/users
		write_users
		reload
		echo "login $user deleted"
		;;
	users) [ -s auth/users ] && cut -d' ' -f1 auth/users || echo "(none)" ;;
	*) usage; [ -z "$cmd" ] || [ "$cmd" = help ] || exit 1 ;;
esac
