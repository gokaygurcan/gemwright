#!/bin/sh
set -eu
: "${GEMWRIGHT_EMULATOR:?Missing emulator}"
marker="/app/data/.$GEMWRIGHT_EMULATOR-initialized"
for other in .initialized .sphere-initialized .sphere-x-initialized .runuo-initialized .modernuo-initialized; do
    if [ "/app/data/$other" != "$marker" ] && [ -e "/app/data/$other" ]; then
        echo 'This volume belongs to another emulator; refusing to reuse it.' >&2
        exit 1
    fi
done
mkdir -p /app/data/server
cd /app/data/server
for directory in Scripts Data Assemblies Configuration; do rm -rf "$directory"; done
cp -a /opt/server/. .
if [ ! -e data ]; then ln -s /app/data data; fi
if [ ! -e "$marker" ]; then
    if [ -e Saves ]; then
        echo 'Existing saves found without initialization marker; refusing to replace them.' >&2
        exit 1
    fi
    cp -a /opt/seed/Saves .
    touch "$marker"
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
    export RAILWAY_TCP_PROXY_DOMAIN="$GEMWRIGHT_PUBLIC_HOST"
    export RAILWAY_TCP_PROXY_PORT=2593
fi
: "${RAILWAY_TCP_PROXY_DOMAIN:?Public hostname is missing}"
: "${RAILWAY_TCP_PROXY_PORT:?Public port is missing}"
exec /opt/gemwright/run-server.sh
