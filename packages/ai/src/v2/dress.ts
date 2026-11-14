import { TileFlag } from '@gemwright/common/assets/tiledata';
import { CommandRejected } from '@gemwright/network/errors';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import type { Terrain } from '../terrain';
import type { Mind } from './mind';
import { screenOf } from './perceive';

// Layers not dressed from the pack: the hands (what it holds is chosen for what it does), and the
// pack, hair, beard, mount and bank, which are not clothes.
const undressed: ReadonlySet<number> = new Set([
  Layer.OneHanded,
  Layer.TwoHanded,
  Layer.Backpack,
  Layer.Hair,
  Layer.FacialHair,
  Layer.Mount,
  Layer.Bank
]);

// Wearing the best it has: for each place on its body, the piece it carries worth the most, put on
// in place of what it wears there if that is worth less. A piece the shard refuses (too heavy for its
// strength) is not tried again. True when it changed anything. What it has is what it knows it has
// (mind.ts); the screen only says whether a piece it put on landed. Death robes never get here: they
// are on the floor first (`shed`).
export async function dress(session: PlayerSession, mind: Mind, terrain: Terrain | undefined) {
  const screen = screenOf(session);
  const self = mind.serial;
  const pack = mind.pack;
  if (self < 0 || pack === undefined) return false;
  const value = (serial: number) => (mind.deathRobe(serial) ? -1 : mind.worthOf(serial));
  const has = mind.has();
  let changed = false;
  for (const item of has.pack.filter((i) => mind.wears(i.serial))) {
    const graphic = mind.graphicOf(item.serial);
    const tile = graphic === undefined ? undefined : terrain?.tile(graphic, true);
    if (!tile) continue;
    if (!(tile.flags & TileFlag.Wearable) || !tile.layer || undressed.has(tile.layer) || mind.deathRobe(item.serial))
      continue;
    const worn = has.worn.find((w) => w.layer === tile.layer);
    if (worn && value(worn.serial) >= value(item.serial)) continue;
    if (worn) await session.moveItem(worn.serial, pack);
    try {
      await session.equipItem(item.serial, tile.layer);
    } catch (error) {
      if (error instanceof CommandRejected) mind.notice('wear-refused', { serial: item.serial });
      throw error;
    }
    for (const end = Date.now() + 1500; Date.now() < end && screen.entities.get(item.serial)?.parent !== self; )
      await Bun.sleep(100);
    if (screen.entities.get(item.serial)?.parent !== self) mind.notice('wear-refused', { serial: item.serial });
    changed = true;
  }
  return changed;
}

// ServUO's action delay (Mobile.ActionDelay, half a second; "You must wait to perform another
// action", 500119): moving one thing after another faster than that is refused.
const pace = 750;
const mustWait = 500119;

// The white robe the shard dresses a raised ghost in (ServUO DeathRobe) has one place: the floor.
// Every one it wears, carries or sees in its open bank box is put down where it stands, one at a time at the pace the shard
// allows, each tried again until it lies there; nothing else is done, and not a step is taken,
// before the last of them is down. True when it carries none.
export async function shed(
  session: PlayerSession,
  mind: Mind,
  stopping: () => boolean,
  // A robe it believes it has and the screen does not show is not there (hands.ts `missing`).
  missing: (serial: number) => void,
  tell: (doing: string) => void
) {
  const screen = screenOf(session);
  const robes = () => {
    const has = mind.has();
    // Its bank box's too, while the box is open on its screen.
    const open = has.bank.filter((item) => mind.sight(item.serial) !== undefined);
    return [...has.worn, ...has.pack, ...open].filter((item) => mind.deathRobe(item.serial)).map((item) => item.serial);
  };
  if (!robes().length) return true;
  let tries = 0;
  for (let robe = robes()[0]; robe !== undefined && !stopping(); robe = robes()[0]) {
    tell(`putting down a death robe (try ${++tries})`);
    if (!screen.entities.has(robe)) {
      missing(robe);
      continue;
    }
    const heard = screen.heard;
    await Bun.sleep(pace);
    // Exactly where it stands, as the shard has it (0x22 answered by 0x20: x, y and z): the drop goes
    // to that tile at that height, never to where the client only believes it is.
    if (!(await session.resyncPosition())) continue;
    try {
      await session.dropAtFeet(robe);
    } catch (error) {
      if (!(error instanceof CommandRejected) && !(error instanceof Error && /lift/i.test(error.message))) throw error;
    }
    // Told to wait, it waits a little longer before the same robe again.
    if (screen.journalSince(heard).some((entry) => entry.cliloc === mustWait)) await Bun.sleep(pace);
  }
  return !robes().length;
}
