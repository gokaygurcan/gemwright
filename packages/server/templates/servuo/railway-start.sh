#!/bin/sh
set -eu

for other in .sphere-initialized .runuo-initialized .modernuo-initialized .sphere-x-initialized; do
    if [ -e "/app/data/$other" ]; then
        echo 'This volume belongs to another emulator; refusing to reuse it.' >&2
        exit 1
    fi
done

mkdir -p /app/data/server
for directory in Config Scripts Data Server Ultima; do
    rm -rf "/app/data/server/$directory"
done
cp -a /opt/servuo/. /app/data/server/
cd /app/data/server
if [ ! -e data ]; then ln -s /app/data data; fi

# gemwright restore uploads a pulled world to restore/Saves and restarts this service: the restored
# saves replace the current ones here, before the server starts, and the replaced ones are kept.
if [ -d /app/data/restore/Saves ]; then
    rm -rf Saves.before-restore
    if [ -e Saves ]; then mv Saves Saves.before-restore; fi
    mv /app/data/restore/Saves Saves
    rm -rf /app/data/restore
    touch /app/data/.initialized
    echo 'Restored the world saves from a gemwright pull.'
fi
if [ ! -e /app/data/.initialized ]; then
    if [ -e Saves ]; then
        echo 'Existing saves found without initialization marker; refusing to replace them.' >&2
        exit 1
    fi
    cp -a /opt/seed/Saves .
    touch /app/data/.initialized
fi

trap 'exit 0' TERM INT
while [ ! -e /app/data/.client-ready ]; do
    if [ -e /app/data/client.tar.gz ]; then
        mkdir -p /app/data/client
        tar -xzf /app/data/client.tar.gz -C /app/data/client
        touch /app/data/.client-ready
        rm /app/data/client.tar.gz
    else
        echo 'Waiting for UO client files on the data volume.'
        sleep 3 &
        wait $! || true
    fi
done

# GEMWRIGHT_TRUSTED_HOSTS (comma-separated host names) is set when AI residents are deployed; the
# server build then includes the AI patch that exempts those hosts from per-address limits.
set --
for host in $(printf '%s' "${GEMWRIGHT_TRUSTED_HOSTS:-}" | tr ',' ' '); do
    set -- "$@" --trusted-host "$host"
done

if [ -n "${GEMWRIGHT_PUBLIC_HOST:-}" ]; then
    exec /opt/gemwright/run-server.sh --public "$GEMWRIGHT_PUBLIC_HOST:2593" "$@" -noconsole
fi
: "${RAILWAY_TCP_PROXY_DOMAIN:?Public hostname is missing}"
: "${RAILWAY_TCP_PROXY_PORT:?Public port is missing}"
exec /opt/gemwright/run-server.sh --public "$RAILWAY_TCP_PROXY_DOMAIN:$RAILWAY_TCP_PROXY_PORT" --railway-proxy "$@" -noconsole
