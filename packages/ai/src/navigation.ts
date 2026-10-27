import { GHOST_BODIES } from '@gemwright/common/bodies';

import { canPause, checkedDelay, urgentAction } from './action-purpose';
import { Blocked } from './blocked';
import { threatsNear } from './danger';
import { directRoute } from './direct-route';
import { holdWhileEngaged, noteStep } from './engagement';
import { land, takeOff } from './flight';
import { confinedToHaven, onHaven } from './haven';
import { pauseFor, slip, walkingPace } from './human-pace';
import { type Link, linkToward } from './links';
import { mountEquipment } from './mount-types';
import type { PlayerSession } from './protocol/session';
import { registerTerrain } from './resident-context';
import { pickUpInReach } from './scavenge';
import { directionTo, type Terrain } from './terrain';
import { noteTrouble } from './trouble';
import { markUnreachable } from './unreachable';
import { passingGreeting } from './wander';

export function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function createNavigator(options: {
  session: PlayerSession;
  terrain: Terrain;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (note: string) => void;
  blocked?: Set<string>;
  onStep?: () => void | Promise<void>;
  runClose?: boolean;
  avoidRest?: boolean;
  purpose?: 'combat' | 'escape';
  // Steer around hostile creatures in sight (default on; off for a fighter at its hunting ground).
  wary?: () => boolean;
  // Never run (a hidden thief sneaking up on a mark).
  walkOnly?: () => boolean;
}) {
  const { session, terrain, check, phase, log } = options;
  registerTerrain(session, terrain);
  const serial = session.world.serial;
  if (serial === null) throw new Error('Navigation requires a character');
  const blocked = options.blocked ?? new Set<string>();
  const position = () => {
    if (!session.world.position) throw new Error('Position is unknown');
    return session.world.position;
  };
  const status = () => {
    if (!session.world.status) throw new Error('Status is unknown');
    return session.world.status;
  };
  const failuresByRoute = new Map<string, { until: number; count: number; error: Blocked }>();
  // Walking goes straight to the goal: no detours by way of places it has no business at.
  // Gargoyles take wing for a long walk and land at its end (flight.ts).
  const walk = async (goal: { x: number; y: number; z?: number }, range: number) => {
    // A Young resident of New Haven does not leave Haven Island (haven.ts).
    if (confinedToHaven(session) && onHaven(position()) && !onHaven(goal))
      throw new Blocked('unreachable', `Staying on Haven Island while Young (not walking to ${goal.x},${goal.y})`);
    const far = distance(position(), goal) > 40 && options.purpose !== 'escape' && options.purpose !== 'combat';
    if (far) await takeOff(session);
    try {
      return await go(goal, range);
    } finally {
      if (far && session.phase === 'ready') await land(session).catch(() => {});
    }
  };
  const go = async (goal: { x: number; y: number; z?: number }, range: number) => {
    // Always give the event loop a turn: a caller looping on an already-reached goal must not
    // starve timers, the shard lease and every other session.
    await Bun.sleep(0);
    let failures = 0;
    let travelled = 0;
    let detouring = false;
    let seenThreats = new Set<number>();
    let waits = 0;
    const linksTried = new Set<Link>();
    // Where this walk began: a teleporter back to it is no way forward (Jhelom's pair of links).
    const start = session.world.position ? { ...session.world.position } : undefined;
    const origins = new Map<string, number>();
    const triedDoors = new Set<number>();
    const lockedDoors = new Set<number>();
    // Steps the server rejected on this route only: mobiles (a following horse, an NPC) move on,
    // so these must not outlive the route like a locked door does.
    const rejected = new Map<string, number>();
    const rejections = new Map<string, number>();
    while (distance(position(), goal) > range || (goal.z !== undefined && Math.abs(position().z - goal.z) > 8)) {
      check();
      const originKey = `${position().x},${position().y},${position().z}`;
      const visits = (origins.get(originKey) ?? 0) + 1;
      origins.set(originKey, visits);
      if (visits > 8) throw new Blocked('unreachable', `Route cycles at ${originKey} toward ${goal.x},${goal.y}`);
      for (const [key, until] of rejected) if (until <= Date.now()) rejected.delete(key);
      const hard = new Set([...blocked, ...rejected.keys()]);
      const occupied = new Set(hard);
      for (const entity of session.world.entities.values()) {
        if (!entity.position || entity.serial === serial || distance(position(), entity.position) > 18) continue;
        const flags = entity.kind === 'item' ? terrain.tile(entity.graphic, true).flags : 0;
        if (entity.kind === 'mobile' || (flags & 0x40 && !(flags & 0x20000000))) {
          if (Math.abs(entity.position.z - position().z) < 16) {
            occupied.add(`${entity.position.x},${entity.position.y}`);
            if (entity.kind === 'item') hard.add(`${entity.position.x},${entity.position.y}`);
          }
        }
      }
      // Seen danger shapes the route, as a player gives a monster a wide berth: the ground around
      // each hostile creature in sight is avoided (wider around archers and casters), unless it
      // is what the walk is for (a hunter closing on its target near the goal). With no way
      // around, the walk stops here instead of running through them.
      const avoid = new Set<string>();
      const careful = options.purpose !== 'combat' && (options.wary?.() ?? true);
      const wary = (careful ? threatsNear(session, position(), 18) : []).filter(
        (m) => m.position && distance(m.position, goal) > range + 3
      );
      for (const m of wary) {
        const at = m.position as { x: number; y: number };
        const r = (m.notoriety ?? 0) === 6 ? 9 : 7;
        // Only ground nearer the creature than it stands now: stepping away is always allowed.
        const now = Math.hypot(position().x - at.x, position().y - at.y);
        for (let dx = -r; dx <= r; dx++)
          for (let dy = -r; dy <= r; dy++)
            if (dx * dx + dy * dy <= r * r && Math.hypot(dx, dy) < now) avoid.add(`${at.x + dx},${at.y + dy}`);
      }
      seenThreats = new Set(wary.map((m) => m.serial));
      if (avoid.size) {
        for (const key of avoid) occupied.add(key);
        for (const key of avoid) hard.add(key);
      }
      let path = detouring ? null : directRoute(terrain, position(), goal, range, occupied, goal.z);
      if (!path) {
        detouring = true;
        path = await terrain.pathAsync(position(), goal, range, occupied, goal.z, session.signal, true);
        if (!path && occupied.size > hard.size)
          path = await terrain.pathAsync(position(), goal, range, hard, goal.z, session.signal, true);
      }
      if (!path?.length && [...rejected.values()].some(Number.isFinite)) {
        await Bun.sleep(1000);
        check();
        continue;
      }
      if (!path?.length && avoid.size && waits < 2) {
        // Every way passes them: back off from them and wait for the road to clear (creatures
        // wander), as a player waits at a distance; twice at most, then it gives up this way.
        waits++;
        const here = position();
        const cx = wary.reduce((n, m) => n + (m.position?.x ?? 0), 0) / wary.length;
        const cy = wary.reduce((n, m) => n + (m.position?.y ?? 0), 0) / wary.length;
        const length = Math.max(1, Math.hypot(here.x - cx, here.y - cy));
        const back = terrain.stand(
          Math.round(here.x + ((here.x - cx) / length) * 15),
          Math.round(here.y + ((here.y - cy) / length) * 15),
          here.z
        );
        phase('waiting-out-danger', `Monsters on the way to ${goal.x},${goal.y}; waiting for them to move on`);
        if (back) {
          const path = await terrain.pathAsync(here, back, 1, hard, undefined, session.signal, true);
          for (const point of path ?? []) {
            const direction = directionTo(position(), point);
            if (direction < 0) break;
            await session.walk(direction);
            await Bun.sleep(220);
          }
        }
        await checkedDelay(30_000 + Math.random() * 30_000, check);
        origins.clear();
        continue;
      }
      if (!path?.length && avoid.size) {
        // Ten minutes for monsters to move on; meanwhile shops, banks and gates elsewhere come first.
        markUnreachable(goal, position(), 10 * 60_000);
        noteTrouble(position(), 'dangerous');
        throw new Blocked(
          'dangerous',
          `Hostile creatures block every way to ${goal.x},${goal.y} (${wary.map((m) => `${m.name ?? 'something'} 0x${m.graphic.toString(16)} at ${m.position?.x},${m.position?.y}`).join(', ')})`
        );
      }
      if (!path?.length) {
        if (lockedDoors.size) throw new Blocked('locked-door', `Locked door blocks every route to ${goal.x},${goal.y}`);
        // No way on foot: a teleporter whose far end is nearer the goal (links.ts), walked onto.
        const link = linkToward(position(), goal, linksTried, start);
        if (link) {
          linksTried.add(link);
          phase('teleporter', `Taking the teleporter at ${link.from.x},${link.from.y}`);
          await go(link.from, 0).catch(() => {});
          await session.waitFor(() => distance(position(), link.to) <= 3, 'teleport', 4000).catch(() => {});
          if (distance(position(), link.to) <= 3) continue;
        }
        markUnreachable(goal, position());
        noteTrouble(goal, 'unreachable');
        throw new Blocked('unreachable', `No walkable route to ${goal.x},${goal.y}`);
      }
      for (const point of path) {
        check();
        // A new hostile creature in sight: plan again around it.
        if (
          careful &&
          threatsNear(session, position(), 14).some(
            (m) => !seenThreats.has(m.serial) && m.position && distance(m.position, goal) > range + 3
          )
        )
          break;
        const before = { ...position() };
        const direction = directionTo(before, point);
        if (direction < 0) break;
        if (before.direction !== direction) {
          const turnAt = performance.now();
          await session.walk(direction);
          await Bun.sleep(Math.max(0, 110 - (performance.now() - turnAt)));
        }
        const ghost = GHOST_BODIES.has(session.world.entities.get(serial)?.graphic ?? 0);
        if (
          !ghost &&
          !options.avoidRest &&
          canPause(session) &&
          status().stamina <= Math.max(3, status().maxStamina * 0.15)
        ) {
          // Overloaded, every step costs more stamina than resting returns: it puts down the
          // cheapest weight and comes back for it later (overload.ts), whoever it is.
          if (status().weight > status().maxWeight) {
            const [{ openOwnBackpack }, { lighten }, { workGear }] = await Promise.all([
              import('./backpack'),
              import('./overload'),
              import('./inventory')
            ]);
            const pack = await openOwnBackpack(session).catch(() => null);
            if (pack !== null) await lighten(session, pack, (item) => workGear.has(item.graphic), log);
          }
          if (status().weight > status().maxWeight)
            throw new Blocked('overweight', `Too heavy to walk: ${status().weight}/${status().maxWeight} stones`);
          phase('resting', `Recovering stamina (${status().stamina}/${status().maxStamina})`);
          const restUntil = Date.now() + 45000;
          while (
            canPause(session) &&
            status().stamina < Math.max(6, status().maxStamina * 0.4) &&
            Date.now() < restUntil
          ) {
            check();
            await Bun.sleep(2000);
            await session.refreshStatus();
          }
          if (canPause(session) && status().stamina <= 3) throw new Error('Stamina did not recover enough to continue');
        }
        const urgent = options.purpose === 'escape' || options.purpose === 'combat';
        const running =
          !options.walkOnly?.() &&
          // Through a crowd or leading someone, people walk (human-pace.ts).
          (urgent || !walkingPace(session)) &&
          (options.runClose || distance(position(), goal) > 3) &&
          (ghost || (status().stamina >= status().maxStamina * 0.35 && status().weight < status().maxWeight * 0.95));
        // Standing to talk with a player pauses every walk (engagement.ts).
        await holdWhileEngaged(session);
        check();
        const sentAt = performance.now();
        const accepted = await session.walk(slip(direction, urgent), point.z, running);
        noteStep(session);
        const mounted = !!mountEquipment(session.world);
        const interval = mounted
          ? (running ? 115 : 220) + Math.random() * 15
          : (running ? 210 : 390) + Math.random() * (running ? 20 : 40);
        await Bun.sleep(Math.max(0, interval - (performance.now() - sentAt)));
        await options.onStep?.();
        // Now and then a stop on the way, as a person looks around (human-pace.ts).
        const pause = pauseFor(session, urgent);
        if (pause) await checkedDelay(pause, check);
        // Every fourth step, loose valuables within reach are taken without leaving the route (not
        // by a thief sneaking up on a mark, whose stealth a lift could break).
        if (accepted && canPause(session) && (travelled & 3) === 0 && !options.walkOnly?.())
          await pickUpInReach(session, terrain, log);
        if (accepted && canPause(session) && travelled % 32 === 0 && !options.walkOnly?.())
          await passingGreeting(session);
        if (accepted && (travelled & 3) === 3) failures = 0;
        if (accepted && ++travelled % 64 === 0)
          log(
            `${mounted ? 'mounted ' : ''}${running ? 'running' : 'walking'} at ${position().x},${position().y}; stamina ${status().stamina}/${status().maxStamina}`
          );
        if (!accepted || distance(position(), point) !== 0) {
          const door = [...session.world.entities.values()]
            .filter(
              (entity) =>
                entity.kind === 'item' &&
                entity.position &&
                distance(before, entity.position) <= 1 &&
                distance(point, entity.position) <= 1 &&
                !triedDoors.has(entity.serial) &&
                terrain.tile(entity.graphic, true).flags & 0x20000000
            )
            .sort((a, b) => distance(point, a.position ?? before) - distance(point, b.position ?? before))[0];
          if (door) {
            triedDoors.add(door.serial);
            const before = new Set(session.world.journal);
            session.use(door.serial);
            await Bun.sleep(600);
            // 502503: "That is locked." Ordinary players cannot pass; route around it.
            if (session.world.journal.some((entry) => !before.has(entry) && entry.cliloc === 502503)) {
              lockedDoors.add(door.serial);
              blocked.add(`${point.x},${point.y}`);
              log(`door ${door.serial} is locked; avoiding ${point.x},${point.y}`);
            }
          } else {
            // A tile refused twice with nobody seen on it is terrain the server disagrees with; keep it
            // for this route. A mobile standing there (a crowded bank) only blocks it briefly.
            const key = `${point.x},${point.y}`;
            const mobileThere = [...session.world.entities.values()].some(
              (e) => e.kind === 'mobile' && e.serial !== serial && e.position?.x === point.x && e.position.y === point.y
            );
            const count = mobileThere ? 0 : (rejections.get(key) ?? 0) + 1;
            rejections.set(key, count);
            rejected.set(key, count > 1 ? Number.POSITIVE_INFINITY : Date.now() + 2000);
          }
          detouring = true;
          log(
            `Movement rejected from ${before.x},${before.y},${before.z} toward ${point.x},${point.y},${point.z}; server position ${position().x},${position().y},${position().z}`
          );
          await Bun.sleep(150);
          if (++failures > 12)
            throw lockedDoors.size
              ? new Blocked('locked-door', 'Route repeatedly blocked by locked doors')
              : new Blocked('unreachable', 'Route repeatedly blocked by server movement feedback');
          break;
        }
      }
    }
  };
  return async (goal: { x: number; y: number; z?: number }, range: number) => {
    const from = position();
    const doors = [...session.world.entities.values()]
      .filter(
        (entity) =>
          entity.kind === 'item' &&
          entity.position &&
          distance(from, entity.position) <= 18 &&
          terrain.tile(entity.graphic, true).flags & 0x20000000
      )
      .map((entity) => `${entity.serial}:${entity.graphic}:${entity.position?.x},${entity.position?.y}`)
      .sort()
      .join('|');
    const key = `${session.world.map}:${from.x >> 7},${from.y >> 7},${from.z}:${goal.x},${goal.y},${goal.z ?? '*'}:${range}:${doors}`;
    const previous = failuresByRoute.get(key);
    if (previous && previous.until > Date.now()) throw previous.error;
    try {
      const result = options.purpose
        ? await urgentAction(session, options.purpose, () => walk(goal, range))
        : await walk(goal, range);
      failuresByRoute.delete(key);
      return result;
    } catch (error) {
      if (error instanceof Blocked) {
        const count = Math.min(6, (previous?.count ?? 0) + 1);
        failuresByRoute.set(key, { error, count, until: Date.now() + Math.min(10 * 60_000, 15_000 * 2 ** count) });
        if (failuresByRoute.size > 64) failuresByRoute.delete(failuresByRoute.keys().next().value as string);
      }
      throw error;
    }
  };
}
