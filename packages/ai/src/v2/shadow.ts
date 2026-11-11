import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { npcTypes } from '@gemwright/common/game/rules';
import type { PlayerSession } from '@gemwright/network/session';

import { isAnkh } from '../decoration';
import { readShardWorld, type ShardWorld } from '../spawns';
import { Terrain } from '../terrain';
import type { History } from './history';
import { isForge } from './knowledge';
import { live } from './live';
import { Mind } from './mind';
import { perceive } from './perceive';
import { Places } from './places';
import { traitsOf } from './traits';

// The shard's world files beside the history (its data folder's `world`), read once.
const worlds = new Map<string, ShardWorld | undefined>();
const shardWorld = (history: string) => {
  const directory = join(dirname(history), 'world');
  if (!worlds.has(directory)) worlds.set(directory, readShardWorld(directory));
  return worlds.get(directory);
};

const npcByName = new Map(npcTypes.map((type) => [type.toLowerCase(), type]));

// What the mind concludes rather than perceives: left out when it re-lives its history.
const concluded = [
  'predicted',
  'outcome',
  'considered',
  'drifted',
  'visited',
  'left',
  'lifetimes',
  'born',
  'trade',
  'looped'
];

// The v2 mind beside v1: it perceives and predicts what v1's attempts will bring, never acting.
export function shadow(session: PlayerSession, resident: string, history: History): () => void {
  return wake(session, resident, history).stop;
}

// The v2 mind living on its own (live.ts) until stopped or the session ends.
export async function act(
  session: PlayerSession,
  resident: string,
  history: History,
  stopping: () => boolean,
  trade: readonly string[] = []
) {
  const { mind, ready, stop, terrain } = wake(session, resident, history, trade);
  try {
    await ready;
    mind.acting = true;
    // Where the shard places healers, ankhs and bankers in Trammel: where a ghost and a depositor go.
    const placed = (kind: string) =>
      (shardWorld(history.path)?.spawners ?? [])
        .filter((s) => s.map === 'Trammel' && s.kinds.some((k) => k.endsWith(kind)))
        .map(({ x, y }) => ({ x, y }));
    await live(
      session,
      mind,
      terrain,
      {
        shrines: [
          ...placed('healer').map((p) => ({ kind: 'healer' as const, ...p })),
          ...(shardWorld(history.path)?.decoration ?? [])
            .filter((p) => isAnkh(p.type))
            .map(({ x, y }) => ({ kind: 'ankh' as const, x, y }))
        ],
        bankers: placed('banker'),
        forges: (shardWorld(history.path)?.decoration ?? [])
          .filter((p) => isForge(p.graphic))
          .map((p) => ({ x: p.x, y: p.y, z: p.z, id: p.graphic })),
        // Vendors the shard places, by the kinds each spawner spawns (its type names as the wiki has them).
        vendors: (shardWorld(history.path)?.spawners ?? [])
          .filter((s) => s.map === 'Trammel')
          .map(({ x, y, kinds, range }) => ({ x, y, range, types: kinds.flatMap((k) => npcByName.get(k) ?? []) }))
          .filter((v) => v.types.length)
      },
      stopping,
      (kind, data) => history.record({ resident, at: Date.now(), kind, data, ...where(session) })
    );
  } finally {
    stop();
  }
}

const where = (session: PlayerSession) => {
  const p = session.world.position;
  return p ? { where: { x: p.x, y: p.y, z: p.z, map: session.world.map ?? 1 } } : {};
};

// On waking the mind re-lives its history in slices, yielding between them so the session keeps
// up; what happens meanwhile waits its turn, and nothing it concludes while re-living is written again.
function wake(session: PlayerSession, resident: string, history: History, trade: readonly string[] = []) {
  const write = (event: Parameters<History['record']>[0]) => history.record(event);
  const { traits, drawn } = traitsOf(history.read(resident, 'born'));
  if (drawn) write({ resident, at: Date.now(), kind: 'born', data: { traits } });
  // Its trade is part of who it is: recorded beside its traits whenever it is new or changed.
  const known = (history.read(resident, 'trade').at(-1) as { skills?: string[] } | undefined)?.skills;
  if (trade.length && JSON.stringify(known) !== JSON.stringify(trade))
    write({ resident, at: Date.now(), kind: 'trade', data: { skills: trade } });
  let awake = false;
  const mind = new Mind(resident, (event) => awake && write(event), traits, shardWorld(history.path)?.spawners, trade);
  mind.awake = false;
  const places = new Places(resident, write, {
    lifetimes: history.read(resident, 'lifetimes'),
    left: history.read(resident, 'left')
  });
  const through = history.latest();
  const compatibility = createHash('sha256')
    .update(
      JSON.stringify({
        version: 2,
        traits,
        trade,
        spawners: shardWorld(history.path)?.spawners
      })
    )
    .digest('hex');
  const saved = history.checkpoint<ReturnType<Mind['snapshot']>>(resident, compatibility);
  if (saved && saved.through <= through) mind.restore(saved.state);
  const after = saved && saved.through <= through ? saved.through : 0;
  const waiting: Parameters<History['record']>[0][] = [];
  // The map files beside the history; without them the land under the cursor stays unknown.
  const assets = join(dirname(history.path), 'assets');
  const mapped = existsSync(assets);
  // Residents live in Trammel, short of its far edges where the terrain reader stops.
  const landAt = (x: number, y: number, map: number | null) =>
    mapped && map === 1 && x < 7167 && y < 4095 ? Terrain.shared(assets, map).cell(x, y).land.id : undefined;
  const stop = perceive(
    session,
    resident,
    (event) => {
      history.record(event);
      places.observe(event);
      if (awake) mind.observe(event);
      else waiting.push(event);
    },
    landAt
  );
  const ready = (async () => {
    let count = 0;
    for (const event of history.lived(resident, through, concluded, after)) {
      mind.observe(event);
      if (++count % 5000 === 0) await Bun.sleep(0);
    }
    history.saveCheckpoint(resident, compatibility, through, mind.snapshot());
    awake = true;
    mind.awake = true;
    for (const event of waiting.splice(0)) mind.observe(event);
  })();
  return {
    mind,
    ready,
    terrain: mapped ? Terrain.shared(assets, 1) : undefined,
    stop: () => {
      stop();
      if (awake) history.saveCheckpoint(resident, compatibility, history.latest(), mind.snapshot());
      else history.flush();
    }
  };
}
