#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$root" in *[!A-Za-z0-9_./-]*) echo 'Use a native deployment path without spaces or shell punctuation.' >&2; exit 1 ;; esac
. "$root/native.env"
if [ "$(id -u)" != 0 ]; then echo 'Native installation requires sudo to install systemd services.' >&2; exit 1; fi
. /etc/os-release
if [ "$ID" != ubuntu ]; then echo 'Native installation currently supports Ubuntu with systemd.' >&2; exit 1; fi
deploy_user=${SUDO_USER:-root}
service="gemwright-$GEMWRIGHT_ID"
if [ -f "/etc/systemd/system/$service.service" ] && ! grep -Fqx "WorkingDirectory=$root" "/etc/systemd/system/$service.service"; then
    echo 'A service with this shard ID already belongs to another deployment directory.' >&2; exit 1
fi

missing=''
for package in $GEMWRIGHT_PACKAGES; do
    if [ "$package" = dotnet-sdk-10.0 ] && command -v dotnet >/dev/null 2>&1 && dotnet --list-sdks | grep -q '^10\.'; then continue; fi
    if [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then
        missing="$missing $package"
    fi
done
if [ -n "$missing" ]; then
    if [ "${1:-}" != --install-deps ]; then
        echo "Missing native dependencies:$missing. Approve installation in the questionnaire or pass --install-deps." >&2
        exit 1
    fi
    apt-get update
    # The package list is generated from the selected emulator, not user input.
    apt-get install -y --no-install-recommends $GEMWRIGHT_PACKAGES
fi
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
mkdir -p "$root/build" "$root/tools"
rm -rf "$root/build/server"
cp -a "$root/shard/server" "$root/build/server"
cd "$root/build/server"
case "$GEMWRIGHT_EMULATOR" in
    servuo) dotnet build ServUO.sln -c Release --nologo -v quiet ;;
    runuo) mcs -optimize+ -unsafe -t:exe -out:RunUO.exe -nowarn:219,414 -d:NEWTIMERS -d:NEWPARENT -d:MONO -reference:System.Drawing -recurse:Server/*.cs ;;
    modernuo) dotnet publish Projects/Application/Application.csproj -c Release --self-contained false --nologo ;;
    sphere) make MAKEFLAGS=-j2 ;;
    sphere-x)
        cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
        cmake --build build -j2
        find build -type f -name 'SphereSvr*' -executable -exec cp {} ./spheresvr \;
        ;;
    *) echo 'Unsupported emulator' >&2; exit 1 ;;
esac
if [ "$GEMWRIGHT_WEB" = 1 ]; then
    if [ ! -x "$root/tools/bun/bun" ]; then
        case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=aarch64 ;; *) echo 'Unsupported Bun architecture' >&2; exit 1 ;; esac
        curl -fL "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-$arch.zip" -o "$root/build/bun.zip"
        unzip -oq "$root/build/bun.zip" -d "$root/build"
        mkdir -p "$root/tools/bun"
        cp "$root/build/bun-linux-$arch/bun" "$root/tools/bun/bun"
    fi
    cd "$root/web"
    "$root/tools/bun/bun" build.ts
    if [ ! -x "$root/tools/caddy/usr/bin/caddy" ]; then
        mkdir -p "$root/build/caddy" "$root/tools/caddy"
        cd "$root/build/caddy"
        apt-get download caddy
        for package in ./*.deb; do dpkg-deb -x "$package" "$root/tools/caddy"; done
    fi
fi

if [ "$GEMWRIGHT_MYSQL" = 1 ]; then
    . "$root/.env"
    systemctl enable --now mysql
    mysql --protocol=socket --user=root <<SQL
CREATE DATABASE IF NOT EXISTS $MYSQLDATABASE;
CREATE USER IF NOT EXISTS '$MYSQLUSER'@'127.0.0.1' IDENTIFIED BY '$MYSQL_PASSWORD';
GRANT ALL PRIVILEGES ON $MYSQLDATABASE.* TO '$MYSQLUSER'@'127.0.0.1';
SQL
fi

# Build first; only stop the live shard once its replacement is ready.
if systemctl cat "$service.service" >/dev/null 2>&1; then systemctl stop "$service.service"; fi
mkdir -p "$root/data/server"
cd "$root/data/server"
marker="$root/data/.$GEMWRIGHT_EMULATOR-initialized"
[ "$GEMWRIGHT_EMULATOR" != servuo ] || marker="$root/data/.initialized"
for other in .initialized .sphere-initialized .sphere-x-initialized .runuo-initialized .modernuo-initialized; do
    if [ "$root/data/$other" != "$marker" ] && [ -e "$root/data/$other" ]; then
        echo 'This data directory belongs to another emulator.' >&2; exit 1
    fi
done
case "$GEMWRIGHT_EMULATOR" in
    servuo|runuo)
        for directory in Config Scripts Data Server Ultima; do rm -rf "$directory"; done
        cp -a "$root/build/server/." .
        ;;
    modernuo)
        for directory in Assemblies Configuration Data; do rm -rf "$directory"; done
        cp -a "$root/build/server/Distribution/." .
        ;;
    sphere|sphere-x)
        rm -rf scripts
        cp -a "$root/shard/shard/." .
        cp "$root/build/server/spheresvr" "$root/tools/spheresvr"
        mkdir -p logs
        ;;
esac
if [ ! -e data ]; then ln -s "$root/data" data; fi
if [ ! -e "$marker" ]; then
    if [ -e Saves ] || [ -e accounts ] || [ -e save ]; then
        echo 'Existing world state has no initialization marker; refusing to overwrite it.' >&2; exit 1
    fi
    cp -a "$root/shard/seed/." .
    touch "$marker"
fi
if [ ! -e "$root/data/.client-ready" ]; then
    mkdir -p "$root/data/client"
    tar -xzf "$root/data/client.tar.gz" -C "$root/data/client"
    touch "$root/data/.client-ready"
    rm "$root/data/client.tar.gz"
fi
chmod +x "$root/"*.sh
chown -R "$deploy_user:$(id -gn "$deploy_user")" "$root"

write_unit() {
    unit=$1
    start=$2
    extra=$3
    cat > "/etc/systemd/system/$unit.service" <<UNIT
[Unit]
Description=Gemwright $unit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$deploy_user
WorkingDirectory=$root
ExecStart=$root/$start
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
$extra

[Install]
WantedBy=multi-user.target
UNIT
}
write_unit "$service" start-native.sh ''
if [ "$GEMWRIGHT_WEB" = 1 ]; then
    write_unit "$service-web" start-web.sh ''
    write_unit "$service-caddy" start-caddy.sh 'AmbientCapabilities=CAP_NET_BIND_SERVICE'
fi
systemctl daemon-reload
systemctl enable "$service.service"
systemctl restart "$service.service"
if [ "$GEMWRIGHT_WEB" = 1 ]; then
    systemctl enable "$service-web.service" "$service-caddy.service"
    systemctl restart "$service-web.service" "$service-caddy.service"
fi
systemctl --no-pager --full status "$service.service"
