import { createMountServices } from './mount-services';
import type { MountContext, MountMemory } from './mount-types';
import { distance } from './navigation';
import { petSource } from './pets';
import { Layer } from './protocol/layers';
import type { Entity } from './protocol/world';

// A gatherer's pack horse or llama, bought from the animal trainer like the riding horse (ServUO
// SBAnimalTrainer: pack horse 631, pack llama 565 gold). Its StrongBackpack holds 1600 stones and
// opens only for its owner (context entry 6145, PackAnimal.CheckAccess), which also proves
// ownership. A follower gives up beyond about five times its perception range, so the owner checks
// behind before moving on and walks back for one left standing. No server help: everything is a
// purchase, speech command, context entry or drag and drop any player has.
export const packBodies = new Set([0x123, 0x124]);
const OPEN_PACK = 6145;
const CAPACITY = 1500;
// The pack animal takes a follower slot beside the riding horse, which is bought first.
const RESERVE = 300;

export function createPackAnimal(ctx: MountContext, city: string) {
  const { session, checkpoint, position, navigate, phase, persist, log, check } = ctx;
  checkpoint.packAnimal ??= { schemaVersion: 1, state: 'seeking' };
  const memory: MountMemory & { load?: number } = checkpoint.packAnimal;
  const services = createMountServices(ctx, city, RESERVE, { bodies: packBodies, name: 'pack animal' });
  let calledAt = 0;
  petSource(session, 'pack-animal', () => (memory.horse === undefined ? [] : [memory.horse]));
  const animal = () => (memory.horse === undefined ? undefined : session.world.entities.get(memory.horse));
  const near = (range: number) => {
    const a = animal();
    return !!a?.position && distance(position(), a.position) <= range;
  };
  const owns = async (mobile: Entity) =>
    (await session.context(mobile.serial).catch(() => [])).some(
      (entry) => entry.cliloc === OPEN_PACK && !(entry.flags & 1)
    );
  const follow = () => {
    if (Date.now() - calledAt < 15_000) return;
    calledAt = Date.now();
    session.say('all follow me');
  };
  // A newly delivered (or, after an uncertain purchase, any nearby) pack animal that answers its owner.
  const discover = async (excluded: readonly number[] = []) => {
    for (const mobile of session.world.entities.values()) {
      if (mobile.kind !== 'mobile' || !packBodies.has(mobile.graphic) || excluded.includes(mobile.serial)) continue;
      if (!mobile.position || distance(position(), mobile.position) > 12 || !(await owns(mobile))) continue;
      memory.horse = mobile.serial;
      memory.state = 'owned';
      memory.load = 0;
      delete memory.pending;
      delete memory.note;
      persist();
      follow();
      return mobile;
    }
    return undefined;
  };

  // Buys one when there is none, the follower slot is free and the gold allows; never a duplicate.
  const acquire = async () => {
    if (memory.horse !== undefined || (memory.retryAfter ?? 0) > Date.now()) return;
    const mount = checkpoint.mount?.state;
    if (mount !== 'owned' && mount !== 'riding') return;
    if (memory.pending) {
      if (await discover(memory.pending.before)) return;
      if (Date.now() - memory.pending.at < 30 * 60_000) return;
      delete memory.pending;
    }
    try {
      await services.purchase(memory, discover);
    } catch (error) {
      check();
      memory.retryAfter = Date.now() + 10 * 60_000;
      persist();
      log(`Pack animal purchase unavailable: ${error instanceof Error ? error.message : error}`);
    }
  };

  // Waits for the animal to come close, calling it and walking back to it if it stays behind.
  // An animal not found where it was last seen is given up as lost; the slot frees on its own.
  const keepUp = async () => {
    if (memory.horse === undefined) return;
    if (near(4)) {
      const at = animal()?.position;
      if (at) memory.lastSeen = { map: session.world.map ?? 1, ...at };
      return;
    }
    phase('pack-animal', 'Waiting for the pack animal to catch up');
    follow();
    await session.waitFor(() => near(4), 'pack animal catching up', 20_000).catch(() => {});
    if (near(4)) return;
    const seen = animal()?.position ?? memory.lastSeen;
    if (seen && (!('map' in seen) || seen.map === session.world.map) && distance(position(), seen) < 120) {
      phase('pack-animal', 'Walking back for the pack animal');
      await navigate(seen, 2).catch(() => {});
      follow();
      await session.waitFor(() => near(4), 'pack animal found', 10_000).catch(() => {});
      if (near(4)) return;
    }
    log('Lost track of the pack animal; working without it');
    memory.state = 'lost';
    delete memory.horse;
    delete memory.load;
    memory.retryAfter = Date.now() + 60 * 60_000;
    persist();
  };

  // Opens the animal's pack beside it and returns the container, or nothing when out of reach.
  const openPack = async () => {
    const a = animal();
    if (!a || !near(2)) return undefined;
    const pack = () =>
      [...session.world.entities.values()].find((item) => item.parent === a.serial && item.layer === Layer.Backpack);
    const shown = session.world.received.get(0x24) ?? 0;
    const menu = await session.context(a.serial).catch(() => []);
    const entry = menu.find((e) => e.cliloc === OPEN_PACK && !(e.flags & 1));
    if (!entry) return undefined;
    session.selectContext(a.serial, entry.index);
    await session
      .waitFor(() => !!pack() && (session.world.received.get(0x24) ?? 0) > shown, 'pack animal backpack', 4000)
      .catch(() => {});
    return pack()?.serial;
  };
  const approach = async () => {
    if (near(2)) return true;
    const at = animal()?.position;
    if (at) await navigate(at, 1).catch(() => {});
    return near(2);
  };

  // Moves carried items of these graphics into the animal's pack; true when anything moved.
  const stow = async (graphics: ReadonlySet<number>) => {
    if (memory.horse === undefined || (memory.load ?? 0) >= CAPACITY) return false;
    await keepUp();
    if (!(await approach())) return false;
    const pack = await openPack();
    if (pack === undefined) return false;
    const items = session.world.childrenOf(ctx.backpack()).filter((item) => graphics.has(item.graphic));
    if (!items.length) return false;
    phase('pack-animal', `Loading ${items.length} stacks onto the pack animal`);
    let moved = false;
    for (const item of items) {
      if ((memory.load ?? 0) >= CAPACITY) break;
      const before = ctx.status().weight;
      try {
        await session.moveItem(item.serial, pack);
      } catch {
        // A full pack or a stack the server refused stays with the owner.
        break;
      }
      await session.refreshStatus();
      memory.load = (memory.load ?? 0) + Math.max(0, before - ctx.status().weight);
      moved = true;
      await Bun.sleep(400);
    }
    persist();
    return moved;
  };

  // Takes items of these graphics (`unit` stones each) back out of the pack while the owner can
  // carry `room` more stones; true when anything came out. An empty pack resets the recorded load.
  const unload = async (graphics: ReadonlySet<number>, unit: number, room: () => number) => {
    if (memory.horse === undefined || !(memory.load ?? 0)) return false;
    await keepUp();
    if (!(await approach())) return false;
    const pack = await openPack();
    if (pack === undefined) return false;
    const inside = () => session.world.childrenOf(pack).filter((item) => graphics.has(item.graphic));
    let moved = false;
    for (const item of inside()) {
      if (room() < unit) break;
      const before = ctx.status().weight;
      const amount = Math.min(item.amount ?? 1, Math.floor(room() / unit));
      try {
        await session.moveItem(item.serial, ctx.backpack(), amount);
      } catch {
        break;
      }
      await session.refreshStatus();
      memory.load = Math.max(0, (memory.load ?? 0) - Math.max(0, ctx.status().weight - before));
      moved = true;
      await Bun.sleep(400);
    }
    if (!session.world.childrenOf(pack).length) memory.load = 0;
    persist();
    return moved;
  };

  return { acquire, keepUp, stow, unload, has: () => memory.horse !== undefined };
}
