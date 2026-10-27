import { HUMAN_ELF_BODIES } from '@gemwright/common/bodies';

import { Blocked } from './blocked';
import type { MinerServicesContext } from './miner-types';
import { distance } from './navigation';

export const forges = new Set([0x0fb1, ...Array.from({ length: 48 }, (_, index) => 6522 + index)]);
const ingot = 0x1bf2;

// Smelting: the nearest free, reachable forge (remembered ones first), an approach from a free
// side, then each ore pile used on it until none is left that this skill can smelt.
export function createSmelter(ctx: MinerServicesContext) {
  const {
    session,
    terrain,
    checkpoint,
    blocked,
    position,
    status,
    check,
    phase,
    log,
    navigate,
    carried,
    smeltable,
    unsmeltable,
    plan,
    progress
  } = ctx;
  return async (backpack: number) => {
    if (!smeltable(backpack).length) return;
    const observedForges = () =>
      [...session.world.entities.values()].flatMap((item) =>
        item.kind === 'item' && item.position && forges.has(item.graphic)
          ? [{ ...item.position, id: item.graphic, serial: item.serial }]
          : []
      );
    const remembered = [...(checkpoint.landmarks?.forges ?? [])]
      .filter((forge) => distance(position(), forge) <= 400)
      .sort((a, b) => distance(position(), a) - distance(position(), b))[0];
    if (remembered && distance(position(), remembered) > 18 && !observedForges().length) {
      phase('forge-search', `Returning to previously observed forge at ${remembered.x},${remembered.y}`);
      await navigate(remembered, 2);
      if (
        !observedForges().some((forge) => distance(forge, remembered) <= 1) &&
        !terrain.cell(remembered.x, remembered.y).statics.some((item) => forges.has(item.id))
      ) {
        checkpoint.landmarks = {
          ...checkpoint.landmarks,
          forges: (checkpoint.landmarks?.forges ?? []).filter((forge) => distance(forge, remembered) > 1)
        };
        phase('forge-missing', 'Previously observed forge is no longer visible here; looking for another');
      }
    }
    const dynamic = observedForges();
    // A forge with someone already working at it costs waiting; a free one a little farther is better.
    const busy = (point: { x: number; y: number }) =>
      [...session.world.entities.values()].some(
        (mobile) =>
          mobile.kind === 'mobile' &&
          mobile.serial !== session.world.serial &&
          HUMAN_ELF_BODIES.has(mobile.graphic) &&
          mobile.position &&
          distance(mobile.position, point) <= 2
      );
    const cost = (point: { x: number; y: number }) => distance(position(), point) + (busy(point) ? 30 : 0);
    const candidates = [
      ...dynamic,
      ...terrain.findStatics(forges, position(), 400).map((item) => ({ ...item, serial: 0 }))
    ].sort((a, b) => cost(a) - cost(b));
    let forge: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      check();
      // The bounded local search cannot vouch for a distant forge; navigation (route corridors)
      // gets there, and a blocked route reports Blocked on the way.
      const far = distance(position(), candidate) > 30;
      const path = far ? null : await terrain.pathAsync(position(), candidate, 2, blocked, undefined, session.signal);
      if (far || (path && Math.abs((path.at(-1) ?? position()).z - candidate.z) <= 8)) {
        forge = candidate;
        break;
      }
      await Bun.sleep(0);
    }
    if (!forge) throw new Error('No reachable forge found in observed items or public terrain');
    const rememberedForges = checkpoint.landmarks?.forges ?? [];
    checkpoint.landmarks = {
      ...checkpoint.landmarks,
      forges: [
        { x: forge.x, y: forge.y, z: forge.z },
        ...rememberedForges.filter((other) => distance(other, forge) > 1)
      ].slice(0, 16)
    };
    plan().pending = 'smelt';
    phase('forge-travel', `Taking ore to forge at ${forge.x},${forge.y}`);
    // Adjacent sides first (clear line of sight); smelting targets reach 2 tiles (ServUO Ore.cs),
    // so the outer ring is a fallback when a horse or another player stands beside the forge.
    const ring = (radius: number) =>
      [-radius, 0, radius].flatMap((dx) =>
        [-radius, 0, radius].flatMap((dy) => (dx || dy ? [{ x: forge.x + dx, y: forge.y + dy }] : []))
      );
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      distance(position(), a) - distance(position(), b);
    const approaches = [
      ...[
        { x: forge.x + 1, y: forge.y },
        { x: forge.x - 1, y: forge.y },
        { x: forge.x, y: forge.y + 1 },
        { x: forge.x, y: forge.y - 1 }
      ].sort(near),
      ...ring(2).sort(near)
    ];
    if (distance(position(), forge) > 20) await navigate(forge, 6);
    let approached = false;
    for (const point of approaches) {
      const path = await terrain.pathAsync(position(), point, 0, blocked, forge.z, session.signal);
      if (!path || Math.abs((path.at(-1) ?? position()).z - forge.z) > 8) continue;
      try {
        await navigate({ ...point, z: forge.z }, 0);
        approached = true;
        break;
      } catch (error) {
        if (session.phase !== 'ready' || !(error instanceof Blocked)) throw error;
        log(`forge approach ${point.x},${point.y} is occupied; trying another side`);
      }
    }
    if (!approached) throw new Error('Forge has no reachable adjacent approach');
    phase('smelting', 'Smelting carried ore through normal item use and forge targeting');
    const countIngots = () =>
      carried(backpack)
        .filter((item) => item.graphic === ingot)
        .reduce((sum, item) => sum + (item.amount ?? 1), 0);
    const initialIngots = countIngots();
    for (let action = 0; action < 100; action++) {
      check();
      const pile = smeltable(backpack)[0];
      if (!pile) break;
      const before = { amount: pile.amount ?? 1, graphic: pile.graphic, ingots: countIngots() };
      session.use(pile.serial);
      await session.waitFor(() => session.world.target !== null, 'ore smelting cursor', 4000);
      const last = session.world.journal.at(-1);
      const tile = terrain.tile(forge.id, true);
      session.target({
        serial: forge.serial,
        x: forge.x,
        y: forge.y,
        z: forge.z + (!forge.serial && tile.flags & 0x200 ? tile.height : 0),
        graphic: forge.id
      });
      const feedback = () =>
        (last ? session.world.journal.slice(session.world.journal.indexOf(last) + 1) : session.world.journal).find(
          (entry) => [501988, 501990, 501986, 501987, 501976, 500446, 500237].includes(entry.cliloc ?? 0)
        );
      await session.waitFor(() => feedback() !== undefined, 'smelting outcome', 4000);
      await Bun.sleep(250);
      const result = feedback()?.cliloc;
      const remaining = session.world.entities.get(pile.serial);
      if (result === 501986 || result === 501987) {
        unsmeltable.add(pile.serial);
        log(`ore ${pile.serial} cannot currently be smelted (${result}); retaining it`);
        continue;
      }
      if (result === 501988) {
        if (countIngots() <= before.ingots) throw new Error('Smelting success was not confirmed by backpack ingots');
        progress.smelts++;
      } else if (result === 501990) {
        if (remaining && remaining.graphic === before.graphic && remaining.amount === before.amount)
          throw new Error('Smelting failure had no confirmed ore change; reconcile before continuing');
      } else throw new Error(`Forge target rejected (${result}); ore retained`);
      log(`smelt: ${result}; backpack contains ${countIngots()} ingots`);
    }
    if (smeltable(backpack).length) throw new Error('Smelting action budget exhausted');
    const produced = countIngots() - initialIngots;
    progress.packRejected = false;
    progress.ingotsProduced += produced;
    if (produced > 0) plan().smeltsSinceBank++;
    delete plan().pending;
    await session.refreshStatus();
    phase('smelt-complete', `Produced ${produced} ingots; carrying ${status().weight}/${status().maxWeight} weight`);
  };
}
