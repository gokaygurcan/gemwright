#!/bin/sh
set -eu

if [ -e /app/data/.initialized ]; then
    echo 'This volume belongs to a ServUO shard; refusing to reuse it for Sphere.' >&2
    exit 1
fi
mkdir -p /app/data/server
cd /app/data/server
rm -rf scripts
cp -a /opt/shard/. .
if [ ! -e data ]; then ln -s /app/data data; fi
if [ ! -e /app/data/.sphere-initialized ]; then
    if [ -e accounts ] || [ -e save ]; then
        echo 'Existing Sphere state found without initialization marker; refusing to replace it.' >&2
        exit 1
    fi
    cp -a /opt/seed/accounts /opt/seed/save .
    touch /app/data/.sphere-initialized
fi
mkdir -p logs

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

: "${RAILWAY_TCP_PROXY_DOMAIN:?Railway TCP proxy is missing}"
: "${RAILWAY_TCP_PROXY_PORT:?Railway TCP proxy port is missing}"
exec /opt/gemwright/run-server.sh --listen 0.0.0.0:2593 --public "$RAILWAY_TCP_PROXY_DOMAIN:$RAILWAY_TCP_PROXY_PORT" --railway-proxy
