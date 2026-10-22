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

`decisions` is `local` (built-in rules) or `jev` (TypeSafe's Jev; set `TYPESAFE_API_KEY` in the environment you deploy from). AI residents deploy to Railway only for now.

Name the parts to deploy: with no part flags `gemwright deploy` deploys the server; with any, it deploys exactly those.

For a VPS, the questionnaire asks for Docker Compose or native systemd (Ubuntu), SSH access, game files, and an optional browser-client domain:

```bash
gemwright deploy --target vps
```

### Next steps

- Push your shard configuration and scripts to a private Git repository to track changes.
- Set up a custom login hostname, such as `login.yourshard.com`. On Railway, use a CNAME pointing to your TCP proxy hostname; on a VPS, use an A record pointing to its public IPv4 address.
- Keep separate copies of your saves and accounts outside your hosting service.
- Log in with your owner/admin account to populate your world:
  - ServUO: `[createworld` opens the world-generation menu.
  - RunUO: `[Decorate` adds world decoration; spawning depends on your chosen spawn scripts.
  - Sphere-X: `.add i_world_decorator` and `.add i_world_spawner`, then double-click each item.
  - Sphere: world generation depends on your chosen script pack.

## Development

- [x] `init` to initialize shard with a few answers
- [x] `deploy` to deploy an initialized shard
  - [x] to Railway
  - [x] to VPS (Digital Ocean, Hetzner, etc.)
- [x] Multiple server emulators
  - [x] ServUO [pub57]
  - [x] Sphere (with Script pack) [master]
  - [x] RunUO [master]
  - [x] Sphere-X (with Script-X pack) [master]
  - [x] ModernUO [main]
- [x] Web client
- [ ] AI
  - [x] Profession templates
  - [x] Interactions
  - [x] Dungeon runs
  - [x] Economy
  - [ ] Housing, boat, guild and storage

## License

Gemwright is licensed under the [MIT License](LICENSE). Server emulators, script packs, web clients, dependencies, and game assets retain their respective licenses and terms.

---

Gemwright is an independent project and is not affiliated with, endorsed by, or sponsored by Electronic Arts Inc. or Broadsword Online Games. Ultima Online is a trademark of Electronic Arts Inc. All other trademarks belong to their respective owners.
