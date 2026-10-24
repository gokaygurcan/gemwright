# Sessions

[Documentation index](README.md)

Each resident is an ordinary game client without a window (`protocol/`): a small TypeScript TCP client checked against ServUO pub57 revision `d76bf4443cf76d081ddaf8f57c87ff33749256af`. No server plugin, privileged API or emulator AI hook is involved.

## Login

A login opens two connections. The first sends the seed and account login, receives the shard list, selects one and gets a relay token. The game connection then goes to the same configured endpoint (never a private host advertised in the relay packet, which matters behind a proxy), sends the token and credentials, receives the character list, and enters or creates the character. The game stream is Huffman-compressed (`packages/common/src/huffman.ts`); the login stream is not.

Session phases are `offline`, `login`, `relay`, `characters`, `entering`, `ready` and `failed`. `SIGINT` and `SIGTERM` close the connection and release the shard lease; the server decides the actual logout timing.

## ServUO profile and provisioning

The runtime supports ServUO only, with an unencrypted classic client identifying as 7.0.45.1 (the connection file's `profile`). `shard-profile.ts` reads the shard's `gemwright.json` (`--shard <path>` on `session` and `population`):

- Any emulator other than ServUO is refused.
- The expansion sets era rules: Stealth's Hiding requirement (30 from Mondain's Legacy, 50 for Samurai Empire, 80 before) and points per hidden step, and whether item property lists exist (from Age of Shadows).
- Accounts are made by ordinary login when `servuo.autoCreateAccounts` is on. Before `--create-character` provisions anyone, the runtime refuses when auto-creation is off and warns when `servuo.accountsPerIp` is below the number of new accounts (a population logs in from one address).

Without `--shard`, ServUO pub57's defaults are assumed: expansion EJ, auto-creation on.

`--create-character` explicitly allows generating an account and creating the character at the normal creation screen (human, the template's city and starting skills, slot 0). Credentials are stored in the resident database ([persistence](persistence.md)). Later runs reuse the same account, binding and slot; a changed character serial, a different character on an unbound account, or missing credentials for a bound resident stops the session for an operator to resolve.

## Capabilities

| Capability | Implementation |
| --- | --- |
| Identity | Bound to the server's character serial, verified on every connection. |
| Movement | One outstanding step; turns and steps told apart; acknowledgement, rejection and correction applied. Terrain routing with road and clearance preferences, running with stamina rests, replanning after rejection, a resync (0x22) on timeout. |
| Position | From the server; acknowledged steps advance X/Y and predict Z from terrain; corrections win. |
| Speech | Unicode speech, with keyword IDs for bank, balance, withdraw, claim and pet orders. |
| Entities | Mobile and item updates, equipment, removal, status, object properties; current observations only, bounded. |
| Containers | Backpack and bank by ordinary double-click; contents as the server sends them. |
| Items | Use, lift, drop, equip, partial stacks, each confirmed by the server. |
| Targeting | Cursor ID and flags; entity, ground and cancel replies; one cursor owner at a time. |
| Skills and spells | Skill use, spell casting from a book, skill and stat locks, skill reports. |
| Vendors | Context menus, buy and sell lists, purchases and sales confirmed by the server. |
| Parties | Invite, accept, decline, leave. |
| Journal | ASCII, Unicode and localized messages with arguments, bounded. |
| Gumps | Plain and packed layouts, close notices, replies with observed buttons; moongate destinations, resurrection, release confirmation. |
| Reconnect | New session, rebuilt observations, same credentials and character ([reconnect](reconnect.md)). |

Unknown packet IDs fail the session rather than guess at stream boundaries. Queues, entities, journal and open UI metadata are bounded.

## Running one resident

Copy `packages/ai/templates/population.example.json` and `packages/ai/connections/servuo.example.json` somewhere operator-controlled, set matching `shardId` values and the real host and port. Keep credentials out of both files.

```sh
# First-time provisioning plus a short capability exercise.
bun run packages/ai/src/index.ts session --config <population.json> --connection <connection.json> \
  --shard <gemwright.json> --create-character --exercise --reconnect --duration 5

# Observe only, reusing the same resident.
bun run packages/ai/src/index.ts session --config <population.json> --connection <connection.json> --duration 60
```

The database defaults to `packages/ai/data/<shardId>/residents.sqlite`; `--resident <UUID>` picks a resident (default: the first desired-active one). `--exercise` takes a few steps, says a greeting, opens the backpack and answers a tool's target cursor. Behaviors take `--miner-assets`, `--fighter-assets` or `--lumberjack-assets` with a `--duration`. Each run prints its result and writes `proofs/<resident UUID>-latest.json` beside the database, without passwords or tokens.
