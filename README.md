# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

## Motivation

Gemwright makes it easier to start an Ultima Online shard and share it with friends. It brings emulator setup and Railway deployment into a small CLI, leaving more time to shape your world.

## Setup

### Sign up to Railway

Create a [Railway account](https://railway.com?referralCode=gokaygurcan) to host your shard. Using this affiliate link helps support Gemwright.

### Install and authenticate Railway CLI

```bash
npm i -g @railway/cli
railway login
```

### Install Gemwright CLI

```bash
npm i -g gemwright
```

### Initialize a new shard

```bash
# with questionnaire
gemwright init [directory]

# or with default values
gemwright init --yes
```

### Deploy to Railway

```bash
# go into the project directory
gemwright deploy
```

```bash
# you need to provide your own game files, we do not ship them.

# deploy both server and web client
gemwright deploy --files /path/to/game-files --client

# or deploy only server
gemwright deploy --files /path/to/game-files
```

### Next steps

- Push your shard configuration and scripts to a private Git repository to track changes.
- Set up a custom login hostname, such as `login.yourshard.com`. Create a DNS CNAME pointing to your Railway TCP proxy hostname.
- Keep separate copies of your saves and accounts outside Railway. (Railway's built-in volume backups require the Pro plan)

## Development

- [x] `init` to initialize shard with a few answers
- [x] `deploy` to deploy initialized shard to Railway
- - [x] to Railway
- - [ ] to VPS (Digital Ocean, Hetzner, etc.)
- [ ] Multiple server emulators
- - [x] ServUO [pub57]
- - [x] Sphere (with Script pack) [master]
- - [ ] RunUO
- - [ ] Sphere-X (with Script-X pack)
- - [ ] ModernUO
- - [ ] POL Server?
- - [ ] Moongate?
- - [ ] ???
- [x] Web client

## License

Gemwright is licensed under the [MIT License](LICENSE). Server emulators, script packs, web clients, dependencies, and game assets retain their respective licenses and terms.

---

Gemwright is an independent project and is not affiliated with, endorsed by, or sponsored by Electronic Arts Inc. or Broadsword Online Games. Ultima Online is a trademark of Electronic Arts Inc. All other trademarks belong to their respective owners.
