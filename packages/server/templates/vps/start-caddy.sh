#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export XDG_DATA_HOME="$root/data/caddy" XDG_CONFIG_HOME="$root/data/caddy-config"
exec "$root/tools/caddy/usr/bin/caddy" run --config "$root/Caddyfile" --adapter caddyfile
