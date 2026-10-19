#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
set -a
. "$root/native.env"
set +a
export UO_HOST=127.0.0.1 UO_PORT=2593 PORT=3000 CLIENT_LISTEN_HOST=127.0.0.1
export CLIENT_BUNDLE_PATH="$root/web/bundle/public" GAMEFILES_PATH="$root/gamefiles"
exec "$root/tools/bun/bun" "$root/web/bundle/server.js"
