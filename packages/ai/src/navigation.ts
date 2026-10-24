import { Blocked } from './blocked';
import { directRoute } from './direct-route';
import { holdWhileEngaged, noteStep } from './engagement';
import { mountEquipment } from './mount-types';
import type { PlayerSession } from './protocol/session';
import { pickUpInReach } from './scavenge';
import { directionTo, type Terrain } from './terrain';
import { markUnreachable } from './unreachable';
import { detourFor, passingGreeting } from './wander';

export const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

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
  // Never run (a hidden thief sneaking up on a mark).
  walkOnly?: () => boolean;
}) {
  const { session, terrain, check, phase, log } = options;
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
  // Chaos on the road (wander.ts): a longer walk sometimes goes by way of a real place first.
  let wandering = false;
  const walk = async (goal: { x: number; y: number; z?: number }, range: number) => {
    if (!wandering && !options.walkOnly?.()) {
      const stop = detourFor(session, position(), goal);
      if (stop) {
        wandering = true;
        try {
          log(`Going by way of ${stop.name === 'guide' ? `a shop in ${stop.city}` : stop.name}`);
          await go(stop, 3);
          await Bun.sleep(3000 + Math.random() * 7000);
        } catch (error) {
          if (!(error instanceof Blocked)) throw error;
        } finally {
          wandering = false;
        }
      }
    }
    return go(goal, range);
  };
  const go = async (goal: { x: number; y: number; z?: number }, range: number) => {
    // Always give the event loop a turn: a caller looping on an already-reached goal must not
    // starve timers, the shard lease and every other session.
    await Bun.sleep(0);
    let failures = 0;
    let travelled = 0;
    let detouring = false;
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
      if (!path?.length) {
        if (lockedDoors.size) throw new Blocked('locked-door', `Locked door blocks every route to ${goal.x},${goal.y}`);
        markUnreachable(goal, position());
        throw new Blocked('unreachable', `No walkable route to ${goal.x},${goal.y}`);
      }
      for (const point of path) {
        check();
        const before = { ...position() };
        const direction = directionTo(before, point);
        if (direction < 0) break;
        if (before.direction !== direction) {
          const turnAt = performance.now();
          await session.walk(direction);
          await Bun.sleep(Math.max(0, 110 - (performance.now() - turnAt)));
        }
        const ghost = [0x192, 0x193, 0x25f, 0x260].includes(session.world.entities.get(serial)?.graphic ?? 0);
        if (!ghost && !options.avoidRest && status().stamina <= Math.max(3, status().maxStamina * 0.15)) {
          phase('resting', `Recovering stamina (${status().stamina}/${status().maxStamina})`);
          const restUntil = Date.now() + 45000;
          while (status().stamina < Math.max(6, status().maxStamina * 0.4) && Date.now() < restUntil) {
            check();
            await Bun.sleep(2000);
            await session.refreshStatus();
          }
          if (status().stamina <= 3) throw new Error('Stamina did not recover enough to continue');
        }
        const running =
          !options.walkOnly?.() &&
          (options.runClose || distance(position(), goal) > 3) &&
          (ghost || (status().stamina >= status().maxStamina * 0.35 && status().weight < status().maxWeight * 0.95));
        // Standing to talk with a player pauses every walk (engagement.ts).
        await holdWhileEngaged(session);
        const sentAt = performance.now();
        const accepted = await session.walk(direction, point.z, running);
        noteStep(session);
        const mounted = !!mountEquipment(session.world);
        const interval = mounted
          ? (running ? 115 : 220) + Math.random() * 15
          : (running ? 210 : 390) + Math.random() * (running ? 20 : 40);
        await Bun.sleep(Math.max(0, interval - (performance.now() - sentAt)));
        await options.onStep?.();
        // Every fourth step, loose valuables within reach are taken without leaving the route (not
        // by a thief sneaking up on a mark, whose stealth a lift could break).
        if (accepted && (travelled & 3) === 0 && !options.walkOnly?.()) await pickUpInReach(session, terrain, log);
        if (accepted && travelled % 32 === 0 && !options.walkOnly?.()) await passingGreeting(session);
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
  return walk;
}
