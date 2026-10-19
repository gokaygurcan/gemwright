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

if [ -n "${GEMWRIGHT_PUBLIC_HOST:-}" ]; then
    exec /opt/gemwright/run-server.sh --public "$GEMWRIGHT_PUBLIC_HOST:2593" -noconsole
fi
: "${RAILWAY_TCP_PROXY_DOMAIN:?Public hostname is missing}"
: "${RAILWAY_TCP_PROXY_PORT:?Public port is missing}"
exec /opt/gemwright/run-server.sh --public "$RAILWAY_TCP_PROXY_DOMAIN:$RAILWAY_TCP_PROXY_PORT" --railway-proxy -noconsole
