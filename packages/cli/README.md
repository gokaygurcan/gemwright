# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

## Usage

```sh
npm install --global @gemwright/cli
gemwright-cli --help
```

```text
Gemwright — Create and manage Ultima Online shards.

Usage:
  gemwright <command> [options]

Commands:
  init [directory]     Initialize a shard project
  shard <command>      Manage a shard

Options:
  -h, --help           Show help
  -V, --version        Show version

Examples:
  gemwright init ./my-shard
  gemwright shard deploy
  gemwright shard status

Run 'gemwright shard --help' for shard commands.

Manage a shard and its components.

Usage:
  gemwright shard <command> [options]

Commands:
  setup       Prepare a VPS for deployments
  deploy      Deploy selected components
  start       Start components
  stop        Stop components
  status      Show deployment status
  logs        View service logs
  pull        Download saves, data and backups
  restore     Restore from a previous pull
  update      Select component package versions

Component selection:
  --server    Shard server
  --client    Web client
  --ai        AI residents

  Combine flags to select multiple components.
  Omit flags to select the components deployed to the target.

Target:
  --target <target>   local | railway | vps

Examples:
  gemwright shard deploy --server --ai
  gemwright shard logs --ai --follow
  gemwright shard stop --client

Run 'gemwright shard <command> --help' for command-specific options.
```

## License

MIT
