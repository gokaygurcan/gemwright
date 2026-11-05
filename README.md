# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

## Motivation

Gemwright makes it easier to start an Ultima Online shard and share it with friends. It brings emulator setup and deployment into a small CLI, leaving more time to shape your world.

## Setup

You need Node.js 24 or newer and your own Ultima Online game files.

### Sign up to Railway (if deploying to Railway)

Create a [Railway account](https://railway.com?referralCode=gokaygurcan) to host your shard. Using this affiliate link helps support Gemwright.

### Install and authenticate Railway CLI (Railway only)

```bash
npm i -g @railway/cli
railway login
```

### Install Gemwright CLI

```bash
npm i -g gemwright
gemwright --help
```

### Initialize a new shard

```bash
# with questionnaire
gemwright init [directory]

# or with default values
gemwright init --yes

# choose an emulator; answer the remaining questions
# options: sphere-x, servuo, sphere, runuo, modernuo
gemwright init --emulator sphere-x

# use defaults for the remaining questions
gemwright init --emulator sphere-x --yes

# optionally add MySQL for Sphere/Sphere-X scripts
gemwright init --emulator sphere-x --mysql --yes
```

MySQL is off by default. On Railway, enabling it provisions a MySQL service in the same project and supplies its connection details through environment variables. Scripts use `DB.CONNECT`, `DB.QUERY`, and `DB.EXECUTE`; world saves and accounts remain in files.

### Deploy your shard

Run this from your shard directory and choose Railway or VPS in the questionnaire:

```bash
# in the project directory
gemwright deploy

# after the initial deployment you can deploy services independently or in combination
gemwright deploy [--server] [--client] [--ai]
```

```bash
# deploy to Railway with your game files

# deploy only the server (the default; --server says the same)
gemwright deploy --target railway --files /path/to/game-files

# deploy the server and the web client
gemwright deploy --target railway --files /path/to/game-files --server --client

# deploy only the web client, next to an already deployed server
gemwright deploy --target railway --files /path/to/game-files --client

# add AI residents (ServUO): the server is rebuilt once with the AI patch
gemwright deploy --target railway --files /path/to/game-files --server --ai
```

AI residents are ordinary players run by a separate service. Configure them in `gemwright.json`:

```json
"ai": { "population": 20, "decisions": "local" }
```

`decisions` accepts `local`, `jev`, `clef`, or an ordered provider list. Each remote entry uses `provider` and `model`; end the list with `{ "provider": "local" }`. The `clef` shorthand selects Clef Flash → Jev → local. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `TYPESAFE_API_KEY` in the environment you deploy from. AI residents deploy to Railway or locally (`--local`) for now.

Name the parts to deploy: with no part flags `gemwright deploy` deploys the server; with any, it deploys exactly those.

For a VPS, the questionnaire asks for Docker Compose or native systemd (Ubuntu), SSH access, game files, and an optional browser-client domain:

```bash
gemwright deploy --target vps
```

### Run your shard locally

With Docker running (Docker Desktop on macOS, or Docker Engine with the Compose plugin), `--local` runs the same parts on this machine as one Compose project in `.gemwright/local/`. Each part is its own container, and deploying one never restarts another. World saves and the resident database stay in that directory across redeploys.

```bash
# the server; native clients log in at 127.0.0.1:2593
gemwright deploy --local --files ~/uo

# add the browser client at http://localhost:3000 beside the local server
gemwright deploy --local --client

# add AI residents: the local server is rebuilt once with the AI patch
gemwright deploy --local --server --ai

# let other machines on your network log in, on other ports (all kept for later deploys)
gemwright deploy --local --public-host 192.168.1.20 --server-port 2600 --client-port 8080

# stop and start parts without rebuilding; data stays in the Docker volumes
gemwright stop --local [--server] [--client] [--ai]
gemwright start --local [--server] [--client] [--ai]
```

Deploying with a different set of game files (`--files`) replaces the set each named part uses, and the world stays as it is.

Every emulator runs locally. On Apple Silicon, Sphere 0.56 builds and runs under Docker's x86-64 emulation, so its first build is slower.

`logs`, `pull` and `restore` accept `--local` too, and read or change the local deployment instead of Railway.

### Pull your shard's state

Saves a copy of the deployed shard locally, on demand: the server's world saves, accounts and logs, a consistent snapshot of the AI residents database with a population report, and recent service logs. Everything lands in `.gemwright/pulls/<time>/` with a `manifest.json` of what came down.

```bash
# in the project directory: everything
gemwright pull

# or only some parts; --backups adds the server's own Backups folder,
# --cleanup deletes older pulls once this one is complete
gemwright pull [--server] [--ai] [--logs] [--backups] [--output <dir>] [--cleanup]

# from the local deployment
gemwright pull --local
```

To pull on a schedule, run `gemwright pull --cleanup` from a cron job.

### Restore a pull

Puts a pull back on a Railway deployment, or the local one with `--local`: the world saves (ServUO) and the AI residents database. The files are uploaded to each volume first, then each service restarts and swaps them in on boot; the replaced files stay on the volume (`server/Saves.before-restore`, `residents.sqlite.before-restore`). Restoring the world disconnects everyone and returns the shard to that save, so the command always asks first.

```bash
# the newest pull, everything in it
gemwright restore

# a specific pull, or only some parts; --yes skips the question
gemwright restore [--from <pull folder>] [--server] [--ai] [--yes]
```

The shard and AI services need a deployment made with this version, whose start scripts do the swap.

### Next steps

- Push your shard configuration and scripts to a private Git repository to track changes.
- Set up a custom login hostname, such as `login.yourshard.com`. On Railway, use a CNAME pointing to your TCP proxy hostname; on a VPS, use an A record pointing to its public IPv4 address.
- Keep separate copies of your saves and accounts outside your hosting service.
- Log in with your owner/admin account to populate your world:
  - ServUO: `[createworld` opens the world-generation menu.
  - RunUO: `[Decorate` adds world decoration; spawning depends on your chosen spawn scripts.
  - Sphere-X: `.add i_world_decorator` and `.add i_world_spawner`, then double-click each item.
  - Sphere: world generation depends on your chosen script pack.

## License

Gemwright is licensed under the [MIT License](LICENSE). Server emulators, script packs, web clients, dependencies, and game assets retain their respective licenses and terms.

---

Gemwright is an independent project and is not affiliated with, endorsed by, or sponsored by Electronic Arts Inc. or Broadsword Online Games. Ultima Online is a trademark of Electronic Arts Inc. All other trademarks belong to their respective owners.
