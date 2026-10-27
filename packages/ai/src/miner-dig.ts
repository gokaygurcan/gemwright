import { ore } from '@gemwright/common/items';

import { urgentAction } from './action-purpose';
import { tally } from './activity';
import { threatsNear } from './danger';
import type { MinerServicesContext } from './miner-types';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
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
    session.use(dig.tool);
    await session.waitFor(() => session.world.target !== null, 'mining tool cursor', 4000);
    const tile = dig.site.graphic ? terrain.tile(dig.site.graphic, true) : null;
    session.target({
      serial: 0,
      x: dig.site.x,
      y: dig.site.y,
      z: dig.site.z + (tile && tile.flags & 0x200 ? tile.height : 0),
      graphic: dig.site.graphic
    });
    attempts++;
    await Bun.sleep(2500);
    if (oreIn(dig.carried(dig.backpack)) > oreBefore) tally(session, 'mined');
    const since = last ? session.world.journal.slice(session.world.journal.indexOf(last) + 1) : session.world.journal;
    const feedback = since.filter((entry) => entry.cliloc !== undefined);
    log(`attempt ${start + attempts}: ${feedback.map((entry) => entry.cliloc).join('; ') || 'no localized feedback'}`);
    if (feedback.some((entry) => [503040, 503042, 500446, 501862, 501863, 500237].includes(entry.cliloc ?? 0))) {
      if (feedback.some((entry) => [503040, 503042].includes(entry.cliloc ?? 0)))
        exhausted.add(`${dig.site.x >> 3},${dig.site.y >> 3}`);
      else exhausted.add(`tile:${dig.site.x},${dig.site.y}`);
      break;
    }
    if (feedback.some((entry) => entry.cliloc === 1044038) || !session.world.entities.has(dig.tool)) break;
    if (!feedback.length)
      throw new Error('Mining produced no interpretable feedback; stopping instead of repeating blindly');
    if (feedback.some((entry) => entry.cliloc === 1010481)) {
      progress.packRejected = true;
      break;
    }
  }
  return attempts;
}
