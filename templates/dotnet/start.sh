#!/bin/sh
set -u
shutdown_dir=$(mktemp -d "${TMPDIR:-/tmp}/gemwright-stop.XXXXXX") || exit 1
export GEMWRIGHT_SHUTDOWN_FILE="$shutdown_dir/request"
trap 'rm -rf "$shutdown_dir"' 0
trap ': > "$GEMWRIGHT_SHUTDOWN_FILE"' TERM INT
case "$GEMWRIGHT_EMULATOR" in
    runuo) set -- mono RunUO.exe -service ;;
    modernuo) set -- dotnet ModernUO.dll ;;
    *) echo 'Unsupported emulator' >&2; exit 1 ;;
esac
"$@" &
server_pid=$!
while :; do
    wait "$server_pid"
    status=$?
    if ! kill -0 "$server_pid" 2>/dev/null; then exit "$status"; fi
done
