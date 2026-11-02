# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

## Usage

```sh
npm install --global @gemwright/cli
gemwright-cli --help
```

```text
Usage: gemwright init [directory] [options]
       gemwright deploy [--files <path>] [--server] [--client] [--ai]
       gemwright deploy --local [--server] [--client] [--ai] [--public-host <host>] [--server-port <n>] [--client-port <n>]
       gemwright stop --local [--server] [--client] [--ai]
       gemwright start --local [--server] [--client] [--ai]
       gemwright deploy --target vps --public-host <host> [--client --domain <host>] [--prepare]
       gemwright update [--server | --client | --ai] [--package-version <exact>]
       gemwright pull [--local] [--server] [--ai] [--logs] [--backups] [--output <dir>] [--cleanup]
       gemwright logs [--local] [--server] [--client] [--ai] [--watch]
       gemwright restore [--local] [--from <pull>] [--server] [--ai] [--yes]

Options:
  --package-version <exact>  Select a published component version (update; does not deploy)
  --name <name>         Shard name (default: Gemwright)
  --timezone <timezone> IANA timezone (default: local zone or Europe/London)
  --expansion <code>    Expansion (default: ej)
  --client-version <v>  Classic client version players use, e.g. 7.0.45.1 (required with --yes)
  --emulator <name>     Server emulator: servuo, sphere, sphere-x, runuo or modernuo (default: servuo)
  --git                 Initialize Git if outside a repository
  --yes                 Accept defaults for unanswered questions
  --mysql               Add MySQL for Sphere/Sphere-X scripts during deployment
  --files <path>        UO client files to import during deployment
  --server              Deploy the shard server (the default when no part is named)
  --client              Deploy the web client
  --ai                  Deploy AI residents (ServUO; settings under "ai" in gemwright.json)
  --local               Use the Docker Compose deployment on this machine (deploy, stop, start, logs, pull, restore)
  --server-port <n>     Local native client port (default: 2593; kept for later deploys)
  --client-port <n>     Local browser client port (default: 3000; kept for later deploys)
  --target <target>     Deployment target: railway (default) or vps
  --public-host <host>  Address native clients use (VPS: required; local: default 127.0.0.1)
  --domain <host>       Browser client HTTPS hostname
  --prepare             Generate a VPS bundle without installing or starting services
  --method <method>     VPS runtime: docker or native (Ubuntu with systemd)
  --ssh <destination>   Deploy over SSH using an alias or user@hostname
  --remote-path <path>  Dedicated deployment directory on the VPS
  --install-deps        Approve installation of missing VPS packages
  --logs                Pull recent service logs (pull)
  --backups             Also pull the server's own Backups folder (pull)
  --output <dir>        Where pull saves (default: .gemwright/pulls/<time>)
  --cleanup             Keep only the newest pull after a complete pull (pull)
  --watch               Keep following new log lines (logs)
  --from <pull>         Pull folder to restore (default: the newest pull)
  --help                Show this help
  --version             Show the installed version
```

## License

MIT
