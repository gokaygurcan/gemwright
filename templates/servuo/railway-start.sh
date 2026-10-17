#!/bin/sh
set -eu

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

: "${RAILWAY_TCP_PROXY_DOMAIN:?Railway TCP proxy is missing}"
: "${RAILWAY_TCP_PROXY_PORT:?Railway TCP proxy port is missing}"
exec /opt/gemwright/run-server.sh --public "$RAILWAY_TCP_PROXY_DOMAIN:$RAILWAY_TCP_PROXY_PORT" --railway-proxy -noconsole
