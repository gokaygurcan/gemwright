# <img src="https://cdn.jsdelivr.net/npm/gemwright@latest/.github/small-forge.png" align="left" alt="Forge your own shard" width="50" height="50" /> Gemwright — Forge your own shard

## Usage

Requires Bun 1.4.3 or newer. Configuration uses environment variables; there is no CLI help command.

```sh
npm install @gemwright/client
cd node_modules/@gemwright/client
UO_HOST=127.0.0.1 GAMEFILES_PATH=/path/to/gamefiles bun bundle/server.js
```

```text
UO_HOST             Server endpoint (required)
GAMEFILES_PATH      Game-file directory with its manifest (required)
UO_PORT             Server port (default: 2593)
UO_CLIENT_VERSION   Client version (default: 7.0.45.1)
UO_ENCRYPTION       Encryption mode, 0–5 (default: 0)
SERVER_NAME         Display name (default: Gemwright)
PUBLIC_ORIGIN       Public HTTPS origin (required on Railway)
CLIENT_BUNDLE_PATH  Browser payload directory (default: bundle/public)
CLIENT_LISTEN_HOST  Listen address (default: ::)
PORT                HTTP port (default: 3000)
```

## License

MIT
