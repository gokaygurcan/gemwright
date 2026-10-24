#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
set -a
. "$root/native.env"
set +a
if [ "$GEMWRIGHT_MYSQL" = 1 ]; then . "$root/.env"; export MYSQLPASSWORD=$MYSQL_PASSWORD; fi
cd "$root/data/server"
export GEMWRIGHT_SPHERE_BINARY="$root/tools/spheresvr"
case "$GEMWRIGHT_EMULATOR" in
    servuo) exec "$root/run-server.sh" --public "$GEMWRIGHT_PUBLIC_HOST:2593" -noconsole ;;
    sphere|sphere-x) exec "$root/run-server.sh" --listen 0.0.0.0:2593 --public "$GEMWRIGHT_PUBLIC_HOST:2593" ;;
    runuo|modernuo)
        export RAILWAY_TCP_PROXY_DOMAIN="$GEMWRIGHT_PUBLIC_HOST" RAILWAY_TCP_PROXY_PORT=2593
        exec "$root/run-server.sh"
        ;;
esac
