#!/bin/sh
set -u

shutdown_dir=$(mktemp -d "${TMPDIR:-/tmp}/gemwright-stop.XXXXXX") || exit 1
shutdown_file="$shutdown_dir/request"
trap 'rm -rf "$shutdown_dir"' 0
shutdown_requested=0
trap 'shutdown_requested=1; : > "$shutdown_file"' TERM INT

mono ./ServUO.exe "$@" --shutdown-file "$shutdown_file" &
server_pid=$!

# A trapped signal interrupts wait before ServUO finishes saving.
while :; do
    wait "$server_pid"
    status=$?
    if ! kill -0 "$server_pid" 2>/dev/null; then
        if [ "$shutdown_requested" -eq 1 ] && [ "$status" -eq 137 ] && [ ! -e "$shutdown_file" ]; then
            exit 0
        fi
        exit "$status"
    fi
done
