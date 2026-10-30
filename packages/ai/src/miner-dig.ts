import { TileFlag } from '@gemwright/common/assets/tiledata';
import { ore } from '@gemwright/common/game/items';
import { Mining, ShardCraft, ShardMessage } from '@gemwright/network/replies';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { urgentAction } from './action-purpose';
import { tally } from './activity';
import { threatsNear } from './danger';
import type { MinerServicesContext } from './miner-types';
import type { Point, Terrain } from './terrain';

export { ore };
export const oreIn = (items: { graphic: number; amount?: number }[]) =>
  items.reduce((sum, item) => sum + (ore.has(item.graphic) ? (item.amount ?? 1) : 0), 0);

// One stay at a mining site: the tool used on the rock or cave floor until the vein is out, the
// pack is full, the tool breaks or a monster arrives. Returns the tool attempts it made.
export async function digSite(
  ctx: {
    session: PlayerSession;
    terrain: Terrain;
    check: () => void;
    status: () => { weight: number; maxWeight: number };
    position: () => Point;
    phase: (value: string, note: string) => void;
    log: (message: string) => void;
    navigate: MinerServicesContext['navigate'];
    home: { x: number; y: number };
    exhausted: { add: (key: string) => void };
    progress: { packRejected: boolean };
  },
  dig: {
    backpack: number;
    carried: (backpack: number) => Entity[];
    tool: number;
    site: { x: number; y: number; z: number; graphic: number; floor?: boolean };
    full: () => boolean;
  },
  start: number
) {
  const { session, terrain, check, position, phase, log, navigate, home, exhausted, progress } = ctx;
  let attempts = 0;
  for (let batch = 0; batch < 40; batch++) {
    check();
    await session.refreshStatus();
    if (dig.full()) break;
    // A monster arriving mid-dig: leave the rock for town (danger.ts remembers the spot).
    if (threatsNear(session, position(), 8).length) {
      phase('avoiding', 'Monsters about; leaving the rock for town');
      await urgentAction(session, 'escape', () => navigate(home, 5)).catch(() => {});
      break;
    }
    const last = session.world.journal.at(-1);
    const oreBefore = oreIn(dig.carried(dig.backpack));
    // A shovel only reaches two tiles, and only a real rock or cave floor can be dug at all: walk to
    // the site before using the tool instead of hitting it from across the room.
    if (Math.max(Math.abs(position().x - dig.site.x), Math.abs(position().y - dig.site.y)) > 2)
      await navigate({ x: dig.site.x, y: dig.site.y, z: dig.site.z }, 1).catch(() => {});
    session.use(dig.tool);
    await session.waitFor(() => session.world.target !== null, 'mining tool cursor', 4000, { resource: 'target' });
    const tile = dig.site.graphic ? terrain.tile(dig.site.graphic, true) : null;
    session.target({
      serial: 0,
      x: dig.site.x,
      y: dig.site.y,
      z: dig.site.z + (tile && tile.flags & TileFlag.Surface ? tile.height : 0),
      graphic: dig.site.graphic
    });
    attempts++;
    await Bun.sleep(2500);
    if (oreIn(dig.carried(dig.backpack)) > oreBefore) tally(session, 'mined');
    const since = last ? session.world.journal.slice(session.world.journal.indexOf(last) + 1) : session.world.journal;
    const feedback = since.filter((entry) => entry.cliloc !== undefined);
    log(`attempt ${start + attempts}: ${feedback.map((entry) => entry.cliloc).join('; ') || 'no localized feedback'}`);
    // Mining.cannotMineThere/Mining.cannotMineThat: the shard refuses the tile ("You can't mine there/that") — not a mine at all.
    // Mining.cannotMineThat and Mining.cannotMineThere mean the same thing from our side, and neither is worth another swing.
    if (feedback.some((entry) => [Mining.cannotMineThere, Mining.cannotMineThat].includes(entry.cliloc ?? 0))) {
      exhausted.add(`${dig.site.x >> 3},${dig.site.y >> 3}`);
      exhausted.add(`tile:${dig.site.x},${dig.site.y}`);
      log(`No mine at ${dig.site.x},${dig.site.y}; the shard refused the tile`);
      break;
    }
    if (feedback.some((entry) => entry.cliloc === Mining.outOfRange)) {
      // Moved out of reach mid-dig: walk back once and keep the vein.
      await navigate({ x: dig.site.x, y: dig.site.y, z: dig.site.z }, 1).catch(() => {});
      continue;
    }
    if (
      feedback.some((entry) =>
        [Mining.noMetal, Mining.alreadyMined, ShardMessage.tooFar, ShardMessage.targetNotSeen].includes(
          entry.cliloc ?? 0
        )
      )
    ) {
      if (feedback.some((entry) => [Mining.noMetal, Mining.alreadyMined].includes(entry.cliloc ?? 0)))
        exhausted.add(`${dig.site.x >> 3},${dig.site.y >> 3}`);
      else exhausted.add(`tile:${dig.site.x},${dig.site.y}`);
      break;
    }
    if (feedback.some((entry) => entry.cliloc === ShardCraft.toolWornOut) || !session.world.entities.has(dig.tool))
      break;
    if (!feedback.length)
      throw new Error('Mining produced no interpretable feedback; stopping instead of repeating blindly');
    if (feedback.some((entry) => entry.cliloc === 1010481)) {
      progress.packRejected = true;
      break;
    }
  }
  return attempts;
}
