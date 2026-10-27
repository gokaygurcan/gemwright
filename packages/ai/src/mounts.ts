import { GARGOYLE_BODIES } from '@gemwright/common/bodies';

import { approachMobile } from './mobile-approach';
import { MOUNT_TOO_ILL, recoverMissingMount } from './mount-care';
import { createMountServices } from './mount-services';
import { horseBodies, type MountContext, mountEquipment } from './mount-types';
import { distance } from './navigation';
import { petSource } from './pets';
import type { Entity } from './protocol/world';
import { animalFromResident } from './resident-offers';

export function createMountController(ctx: MountContext, city: string, reserve = 250) {
  const { session, checkpoint, position, persist, check, phase, log } = ctx;
  if (checkpoint.mount && checkpoint.mount.schemaVersion !== 1) throw new Error('Unsupported mount memory schema');
  checkpoint.mount ??= { schemaVersion: 1, state: 'seeking' };
  const memory = checkpoint.mount;
  const services = createMountServices(ctx, city, reserve);
  const verified = new Set<number>();
  let nextAttempt = 0;
  // An unridden horse is a pet to gather before a moongate; a ridden one travels with its rider.
  petSource(session, 'horse', () =>
    memory.horse !== undefined && memory.state !== 'riding' && !mountEquipment(session.world) ? [memory.horse] : []
  );
  const observe = () => {
    const equipment = mountEquipment(session.world);
    if (equipment) {
      const changed = memory.state !== 'riding' || memory.equipment !== equipment.serial;
      if (memory.equipment !== undefined && memory.equipment !== equipment.serial) delete memory.horse;
      memory.state = 'riding';
      memory.equipment = equipment.serial;
      memory.lastSeen = { map: session.world.map ?? 1, ...position() };
      if (changed) persist();
      return true;
    }
    const horse = memory.horse === undefined ? undefined : session.world.entities.get(memory.horse);
    if (horse?.position) memory.lastSeen = { map: session.world.map ?? 1, ...horse.position };
    return false;
  };
  // Horses whose context menu never answered (dead, gone, or out of reach): skipped for a while,
  // so one silent horse cannot stop the search from concluding the owned horse is missing.
  const silent = new Map<number, number>();
  const owned = async (horse: Entity) => {
    if (verified.has(horse.serial)) return true;
    if ((silent.get(horse.serial) ?? 0) > Date.now()) return false;
    let menu: Awaited<ReturnType<typeof session.context>>;
    try {
      menu = await session.context(horse.serial);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      silent.set(horse.serial, Date.now() + 10 * 60_000);
      return false;
    }
    // Friends can follow/stay too; Guard and Transfer are offered only to the owner.
    if (menu.some((entry) => [3006107, 3006113].includes(entry.cliloc) && !(entry.flags & 1))) {
      verified.add(horse.serial);
      return true;
    }
    return false;
  };
  const discover = async (excluded: readonly number[] = []) => {
    const candidates = [...session.world.entities.values()].filter(
      (e) =>
        e.kind === 'mobile' &&
        horseBodies.has(e.graphic) &&
        e.position &&
        distance(position(), e.position) <= 12 &&
        !excluded.includes(e.serial)
    );
    for (const horse of candidates.sort(
      (a, b) => Number(b.serial === memory.horse) - Number(a.serial === memory.horse)
    )) {
      check();
      if (await owned(horse)) {
        memory.horse = horse.serial;
        memory.state = 'owned';
        memory.lastSeen = { map: session.world.map ?? 1, ...(horse.position ?? position()) };
        delete memory.pending;
        delete memory.retryAfter;
        memory.note = 'Horse ownership confirmed by owner-only server context actions';
        persist();
        return horse;
      }
    }
  };
  const ride = async () => {
    if (observe()) return true;
    if (Date.now() < nextAttempt) return false;
    nextAttempt = Date.now() + 15_000;
    check();
    try {
      if (memory.horse !== undefined && session.world.deaths.has(memory.horse)) {
        memory.state = 'lost';
        memory.note = 'Observed horse death; a replacement may be bought when affordable';
        delete memory.horse;
        delete memory.equipment;
        delete memory.pending;
        persist();
      }
      const safe = (point: { x: number; y: number }) =>
        ctx.status().hits >= ctx.status().maxHits * 0.8 &&
        (ctx.safeToRecover?.(point) ??
          ![...session.world.entities.values()].some(
            (e) =>
              e.kind === 'mobile' &&
              e.serial !== ctx.serial &&
              e.serial !== memory.horse &&
              e.position &&
              [4, 5, 6].includes(e.notoriety ?? 0) &&
              distance(point, e.position) < 10
          ));
      const seen = memory.horse === undefined ? undefined : session.world.entities.get(memory.horse);
      if (seen?.position && distance(position(), seen.position) > 12 && safe(seen.position))
        await approachMobile(ctx, seen.serial);
      const hint = memory.lastSeen ?? memory.pending;
      if (
        !seen &&
        hint?.map === session.world.map &&
        distance(position(), hint) > 12 &&
        (distance(position(), hint) <= 64 || (memory.state === 'missing' && (ctx.status().followers ?? 0) > 0)) &&
        (memory.retryAfter ?? 0) <= Date.now() &&
        safe(hint)
      ) {
        // A horse still counted as a follower is alive where it was left (a death site, say):
        // go back for it however far, every ten minutes, rather than buy another.
        memory.retryAfter = Date.now() + (distance(position(), hint) <= 64 ? 120_000 : 10 * 60_000);
        phase('mount-search', 'Checking the nearby last observed horse location before continuing on foot');
        await ctx.navigate(hint, 2);
      }
      const horse = await discover(memory.pending?.before ?? []);
      if (!horse) {
        if (memory.horse !== undefined || memory.pending || memory.state === 'riding') {
          memory.state = memory.pending ? 'purchase-pending' : 'missing';
          memory.note = 'Horse is not currently observed as owned; continuing on foot without buying a duplicate';
          persist();
        }
        return false;
      }
      await approachMobile(ctx, horse.serial);
      phase('mounting', `Riding owned horse ${horse.serial}`);
      const before = new Set(session.world.journal);
      const ownershipDenied = () =>
        session.world.journal.some(
          (entry) => !before.has(entry) && entry.serial === horse.serial && [501263, 501264].includes(entry.cliloc ?? 0)
        );
      const ill = () =>
        session.world.journal.some(
          (entry) => !before.has(entry) && entry.serial === horse.serial && entry.cliloc === MOUNT_TOO_ILL
        );
      session.use(horse.serial);
      await session.waitFor(
        () => !!mountEquipment(session.world) || ownershipDenied() || ill(),
        'server mount equipment',
        3000
      );
      if (ill()) {
        // A poisoned horse refuses riders (BaseMount); it keeps following while the poison runs out.
        nextAttempt = Date.now() + 60_000;
        memory.note = 'Horse is too ill to ride; walking while it recovers';
        persist();
        phase('mount-ill', memory.note);
        return false;
      }
      if (ownershipDenied()) {
        verified.delete(horse.serial);
        delete memory.horse;
        delete memory.equipment;
        memory.state = 'lost';
        memory.note = 'Server refused mount ownership; replacement may be sought';
        persist();
        return false;
      }
      observe();
      persist();
      return true;
    } catch (error) {
      check();
      log(`Mount unavailable; continuing on foot: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  };
  const acquire = async () => {
    // Gargoyles cannot ride (ServUO BaseMount: "You cannot ride in your current form"); they fly.
    if (GARGOYLE_BODIES.has(session.world.entities.get(ctx.serial)?.graphic ?? 0)) return;
    if (observe() || (memory.retryAfter ?? 0) > Date.now()) return;
    if (await ride()) return;
    if (memory.state === 'missing' && (await recoverMissingMount(ctx, city, memory, discover))) {
      nextAttempt = 0;
      await ride();
      return;
    }
    if (memory.pending || memory.horse || memory.state === 'missing') return;
    // A tamer's spare mount nearby comes cheaper than the stable's (resident-offers.ts).
    if (await animalFromResident(ctx, 'mount')) {
      await discover();
      await ride();
      return;
    }
    try {
      await services.purchase(memory, discover);
      nextAttempt = 0;
      await ride();
    } catch (error) {
      check();
      memory.retryAfter = Date.now() + 60_000;
      memory.note = memory.pending
        ? 'Purchase acknowledgement uncertain; automatic repurchase blocked'
        : 'Trainer trip unavailable; continuing on foot';
      persist();
      log(`${memory.note}: ${error instanceof Error ? error.message : error}`);
    }
  };
  const dismountForGathering = async () => {
    if (mountEquipment(session.world)) {
      phase('dismounting', 'Dismounting before gathering');
      session.setWarMode(false);
      session.use(ctx.serial);
      await session.waitFor(() => !mountEquipment(session.world), 'server dismount acknowledgement', 3000);
      nextAttempt = 0;
    }
    try {
      const horse = await discover();
      if (!horse) {
        memory.note = 'Horse follow was not confirmed; gathering on foot';
        log(`${memory.note}: no owned horse answered nearby`);
      }
      if (horse?.position && distance(position(), horse.position) <= 12) {
        const follow = (await session.context(horse.serial)).find(
          (entry) => entry.cliloc === 3006108 && !(entry.flags & 1)
        );
        if (follow) {
          session.selectContext(horse.serial, follow.index);
          await session.waitFor(() => session.world.target !== null, 'horse follow target', 2500);
          session.target({
            serial: ctx.serial,
            ...position(),
            graphic: session.world.entities.get(ctx.serial)?.graphic ?? 0
          });
        }
      }
    } catch (error) {
      check();
      if (session.world.target) session.target(null);
      memory.note = 'Horse follow was not confirmed; gathering on foot';
      log(`${memory.note}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (mountEquipment(session.world)) throw new Error('Cannot gather while mounted');
    memory.state = memory.horse ? 'owned' : memory.state;
    persist();
  };
  return { ride, acquire, observe, dismountForGathering };
}

export const RIDE_DISTANCE = 12;

export function mountedNavigator(
  navigate: MountContext['navigate'],
  controller: () => ReturnType<typeof createMountController> | undefined,
  allowed = () => true,
  position?: () => { x: number; y: number }
): MountContext['navigate'] {
  return async (goal, range) => {
    // Short hops (between neighbouring ore spots, around a shop) are walked, as a player would.
    const far = !position || distance(position(), goal) > RIDE_DISTANCE;
    if (far && allowed()) await controller()?.ride();
    await navigate(goal, range);
    controller()?.observe();
  };
}
