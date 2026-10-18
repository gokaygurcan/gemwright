#!/bin/sh
set -u

shutdown_dir=$(mktemp -d "${TMPDIR:-/tmp}/gemwright-stop.XXXXXX") || exit 1
shutdown_file="$shutdown_dir/request"
trap 'rm -rf "$shutdown_dir"' 0
trap ': > "$shutdown_file"' TERM INT

if [ "${GEMWRIGHT_MYSQL:-0}" = 1 ]; then set -- "$@" --mysql-env; fi

stdbuf -oL -eL /opt/sphere/spheresvr "$@" --shutdown-file "$shutdown_file" &
server_pid=$!
while :; do
    wait "$server_pid"
    status=$?
    if ! kill -0 "$server_pid" 2>/dev/null; then
        exit "$status"
    fi
done
