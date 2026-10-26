# Reconnect and interrupted work

[Documentation index](README.md)

## Automatic reconnect

`behavior-supervisor.ts` supervises a resident's behavior. A retryable transport failure or uncertain movement closes the old session, waits with bounded backoff (500 ms, doubling, at most five seconds), opens a fresh session and reruns the behavior from the latest checkpoint and rebuilt observations. Each connection verifies the bound character serial and uses the resident's stored credentials.

- The run's deadline is shared across reconnects; reconnecting never starts a new full-length run.
- `--reconnect-attempts` is a total budget for the command, not per connection.
- Shutdown and lost shard ownership stop the process. Authentication failures, unsupported packets and a changed character identity are reported, not retried.
- A behavior that returns while its session is still ready is a legal outcome, not a reason to restart.
- An uncertain item transfer is never replayed: the restarted behavior first reopens its inventory and continues from its persisted intent.

Session results record the behavior runs, recovery attempts and whether a reconnect happened; counters accumulate across segments.

## Interrupted encounters

Before approaching an opponent, the fighter persists an encounter marker: the opponent serial, start time and last approach position (a search hint if the death location is lost, never proof of a corpse). The marker lasts through combat and looting and is cleared after looting or a confirmed bank visit.

A run that starts with an unfinished encounter refreshes status, opens the backpack, leaves war mode and returns to town with escape movement. It never replays an attack, claims an unobserved kill or retries a corpse transfer from the old goal; recorded loot is handled only if it is actually in the pack. The return intent is saved before moving, so a second interruption still leads home. Death recovery and the miner's smelting and banking reconciliation run the same way before new work.

Related: [sessions](sessions.md) · [persistence](persistence.md).
