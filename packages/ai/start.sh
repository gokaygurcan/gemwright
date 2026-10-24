#!/bin/sh
set -eu

# The deployment uploads the map files the residents walk by as /app/data/assets.tar.gz.
trap 'exit 0' TERM INT
# A newer upload replaces the extracted files.
while [ ! -e /app/data/.assets-ready ] || [ -e /app/data/assets.tar.gz ]; do
    if [ -e /app/data/assets.tar.gz ]; then
        rm -rf /app/data/assets
        mkdir -p /app/data/assets
        tar -xzf /app/data/assets.tar.gz -C /app/data/assets
        touch /app/data/.assets-ready
        rm /app/data/assets.tar.gz
    else
        echo 'Waiting for map files on the data volume.'
        sleep 3 &
        wait $! || true
    fi
done
trap - TERM INT

cd /app
exec bun packages/ai/src/serve.ts
