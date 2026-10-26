#!/bin/sh
set -eu

# gemwright restore uploads a pulled resident database to restore/ and restarts this service: it
# replaces the current one here, before the residents start, and the replaced one is kept.
if [ -e /app/data/restore/residents.sqlite ]; then
    rm -f /app/data/residents.sqlite.before-restore
    if [ -e /app/data/residents.sqlite ]; then mv /app/data/residents.sqlite /app/data/residents.sqlite.before-restore; fi
    rm -f /app/data/residents.sqlite-wal /app/data/residents.sqlite-shm
    mv /app/data/restore/residents.sqlite /app/data/residents.sqlite
    rm -rf /app/data/restore
    echo 'Restored the resident database from a gemwright pull.'
fi

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
