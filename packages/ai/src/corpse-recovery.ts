import { nearAnyGround } from './cemeteries';
import { threatsNear } from './danger';
import { moongates, nearestGate, travelByMoongate } from './moongate';
import type { MountContext } from './mount-types';
import { distance } from './navigation';

// Back to its own corpse after a resurrection, as a player does. ServUO's self-loot (Corpse.Open,
// AOS) does the rest when the owner double-clicks its corpse: every item that was worn goes back
// on, everything else goes into the pack, and the death robe is deleted. The corpse decays seven
// minutes after death (Corpse.m_DefaultDecayTime), so a trip that cannot arrive in time is not
// started; a resident who could not get its clothes back buys a robe later (death-robe.ts).
const CORPSE = 0x2006;
const DECAY_MS = 7 * 60_000;
const WALKING_LIMIT = 300;

// Deaths by place, so a resident that died twice near one spot in an hour stops going back.
const deaths = new WeakMap<object, { x: number; y: number; at: number }[]>();

type Ctx = Pick<MountContext, 'session' | 'serial' | 'terrain' | 'position' | 'navigate' | 'check' | 'phase' | 'log'>;

export async function recoverOwnCorpse(ctx: Ctx, place: { x: number; y: number }, diedAt: number) {
  const { session, position, navigate, phase, log } = ctx;
  const here = (deaths.get(session) ?? []).filter((d) => Date.now() - d.at < 3_600_000);
  deaths.set(session, [...here, { ...place, at: diedAt }]);
  // Never back into what killed it: a monster spawn (hunting-grounds.json, cemeteries), monsters
  // seen there, or a spot where it already died this hour. The robe is replaced later instead.
  const why = nearAnyGround(place)
    ? 'it lies in monster country'
    : here.some((d) => distance(d, place) < 40)
      ? 'I already died there once this hour'
      : threatsNear(session, place, 12).length
        ? 'monsters are about it'
        : undefined;
  if (why) {
    log(`Leaving my corpse at ${place.x},${place.y}: ${why}`);
    return false;
  }
  // About a tile a second on foot, a minute through a moongate; a minute of margin.
  const far = distance(position(), place) > WALKING_LIMIT;
  const eta = (far ? 60_000 + distance(moongates[nearestGate(place)], place) : distance(position(), place)) * 1000;
  if (Date.now() + eta + 60_000 > diedAt + DECAY_MS) {
    log(`Too far from my corpse at ${place.x},${place.y} to reach it before it decays`);
    return false;
  }
  phase('corpse-recovery', `Going back to my corpse near ${place.x},${place.y}`);
  try {
    if (far) await travelByMoongate(ctx, nearestGate(place));
    await navigate(place, 2);
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    log(`Could not reach my corpse: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  const me = session.world.entities.get(ctx.serial)?.name ?? '';
  const corpses = [...session.world.entities.values()]
    .filter((item) => item.graphic === CORPSE && item.position && distance(item.position, place) <= 6)
    .sort((a, b) => distance(position(), a.position ?? place) - distance(position(), b.position ?? place));
  for (const corpse of corpses.slice(0, 4)) {
    // Only its own: a corpse's name property reads "a corpse of <name>"; another's is never touched.
    await session.inspectProperties(corpse.serial).catch(() => {});
    const named = session.world.entities.get(corpse.serial)?.properties?.some((p) => me && p.arguments.includes(me));
    if (!named || !corpse.position) continue;
    await navigate(corpse.position, 1).catch(() => {});
    session.use(corpse.serial);
    await Bun.sleep(1500);
    phase('corpse-recovered', 'Took my belongings back from my corpse');
    return true;
  }
  log(`My corpse near ${place.x},${place.y} is gone`);
  return false;
}
