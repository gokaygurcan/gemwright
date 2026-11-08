#!/bin/sh
set -eu

rm -f /app/data/.ai-ready

# gemwright restore uploads a pulled resident database to restore/ and restarts this service: it
# replaces the current one here, before the residents start, and the replaced one is kept.
if [ -e /app/data/restore/residents.sqlite ]; then
    rm -f /app/data/residents.sqlite.before-restore
    if [ -e /app/data/residents.sqlite ]; then mv /app/data/residents.sqlite /app/data/residents.sqlite.before-restore; fi
    rm -f /app/data/residents.sqlite-wal /app/data/residents.sqlite-shm
    mv /app/data/restore/residents.sqlite /app/data/residents.sqlite
    # The residents retired by hand travel with the database they belong to.
    if [ -e /app/data/restore/retired.json ]; then mv /app/data/restore/retired.json /app/data/retired.json; fi
    rm -rf /app/data/restore
    echo 'Restored the resident database from a gemwright pull.'
fi

# The deployment uploads the map files the residents walk by as /app/data/assets.tar.gz.
trap 'exit 0' TERM INT
# A newer upload replaces the extracted files.
# Docker deployments mount the shared game-file folder there instead, ready as it is.
while { [ ! -e /app/data/.assets-ready ] && [ -z "$(ls -A /app/data/assets 2>/dev/null)" ]; } || [ -e /app/data/assets.tar.gz ]; do
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
# The shard's world files (spawners and regions) the residents learn the land from, uploaded as
# /app/data/world.tar.gz by the deployment; a newer upload replaces them, and they stay between deploys.
# Waited for like the map files: the upload needs this container running.
while [ ! -e /app/data/world/Regions.xml ] || [ ! -e /app/data/world/teleporters.csv ] || [ ! -d /app/data/world/Decoration ] || [ -e /app/data/world.tar.gz ]; do
    if [ -e /app/data/world.tar.gz ]; then
        rm -rf /app/data/world
        mkdir -p /app/data/world
        tar -xzf /app/data/world.tar.gz -C /app/data/world
        rm /app/data/world.tar.gz
    else
        echo 'Waiting for world files on the data volume.'
        sleep 3 &
        wait $! || true
    fi
done
trap - TERM INT

cd /app
exec bun /app/dist/serve.js
