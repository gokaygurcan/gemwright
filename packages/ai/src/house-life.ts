import { gold } from '@gemwright/common/items';

import { chaosOf } from './chaos';
import { type HouseRecord, houseOf, housingOpen, updateHouse } from './house-lots';
import { backpackOf, buyHouse, buyOne, houseGoal, ownerOf, ownsHouse, type Purchase, travelTo } from './housing';
import { quality } from './item-quality';
import type { LifeContext } from './life';
import { distance } from './navigation';

// A resident with a house lives with it: it goes to buy one once its savings reach the goal
// (housing.ts), visits it about once a day (opening its door refreshes ServUO's decay timer for
// the owner, HouseDoors.cs), keeps a secured wooden box there for its valuables, and sometimes
// spends its leisure at home. Nothing is ever deleted: a house outlives its owner's deaths.
const BOX = 0x0e7d;
const nextCheck = new WeakMap<LifeContext['session'], number>();
// After an attempt: blocked lots are retried at once on another lot, everything else waits.
const backoff: Record<Purchase, number> = {
  placed: 0,
  refused: 2 * 60_000,
  failed: 30 * 60_000,
  unaffordable: 2 * 3_600_000,
  'no-lot': 6 * 3_600_000
};

// At a break point: true when this turn went to the house.
export async function housingTurn(ctx: LifeContext): Promise<boolean> {
  if (!housingOpen()) return false;
  const { session } = ctx;
  const now = Date.now();
  if ((nextCheck.get(session) ?? 0) > now) return false;
  nextCheck.set(session, now + 3 * 60_000);
  const owner = ownerOf(ctx);
  if (!owner) return false;
  if (!ownsHouse(owner)) {
    if ((ctx.checkpoint.funds?.bank ?? 0) < houseGoal()) return false;
    const result = await buyHouse(ctx).catch((error) => {
      if (session.phase !== 'ready') throw error;
      ctx.log(`House purchase interrupted: ${error instanceof Error ? error.message : error}`);
      return 'failed' as const;
    });
    nextCheck.set(session, Date.now() + Math.max(3 * 60_000, backoff[result]));
    return true;
  }
  const house = houseOf(owner);
  if (house?.status !== 'placed') return false;
  // About once a day, sooner or later by the resident's chaos.
  const every = (20 + (Math.random() * 2 - 1) * 4 * chaosOf(session)) * 3_600_000;
  if (now - (house.visitedAt ?? 0) < every) return false;
  await visitHouse(ctx, house, 60_000 + Math.random() * 120_000);
  return true;
}

// Leisure at home now and then (life.ts): true when the time was spent there.
export async function leisureAtHome(ctx: LifeContext, until: number): Promise<boolean> {
  const house = houseOf(ownerOf(ctx));
  if (house?.status !== 'placed' || Math.random() >= 0.3) return false;
  await visitHouse(ctx, house, Math.max(30_000, until - Date.now()));
  return true;
}

// Steps straight north or south along the lot's centre line (the door is at the middle of the
// south wall); the house is not in the map files, so the path planner cannot see its walls.
async function walkLine(ctx: LifeContext, x: number, toY: number) {
  for (let tries = 0; tries < 20 && ctx.position().y !== toY; tries++) {
    ctx.check();
    const here = ctx.position();
    if (here.x !== x) {
      await ctx.navigate({ x, y: here.y }, 0).catch(() => {});
      continue;
    }
    if (!(await ctx.session.walk(here.y > toY ? 0 : 4))) await Bun.sleep(600);
  }
  return ctx.position().y === toY;
}

async function visitHouse(ctx: LifeContext, house: HouseRecord, stay: number) {
  const { session } = ctx;
  ctx.phase('home', `Going home to my ${house.house ?? 'house'}`);
  // A box for the house, bought on the way while there is none yet.
  const box = () => session.world.childrenOf(backpackOf(ctx)).find((i) => i.graphic === BOX);
  if (!house.storage && !box()) await buyOne(ctx, 'provisioner', BOX, 30).catch(() => false);
  await travelTo(ctx, { x: house.x, y: house.y + 6 }, 1);
  const door = [...session.world.entities.values()].find(
    (i) => i.kind === 'item' && i.position && i.position.x === house.x && i.position.y === house.y + 3
  );
  if (door) {
    session.use(door.serial);
    await Bun.sleep(800);
  }
  updateHouse(house.owner, { visitedAt: Date.now() });
  if (!(await walkLine(ctx, house.x, house.y))) {
    ctx.log('Could not get inside my house');
    return;
  }
  await furnish(ctx, house, box()?.serial);
  ctx.phase('home', 'At home for a while');
  const until = Date.now() + stay;
  while (Date.now() < until && session.phase === 'ready') {
    ctx.check();
    await Bun.sleep(5000);
  }
  if (door) session.use(door.serial);
  await walkLine(ctx, house.x, house.y + 6);
}

// The secured box: dropped inside and secured ("I wish to secure this", keyword 0x25), then the
// resident's kept valuables go into it, out of the bank box's 125-item limit.
async function furnish(ctx: LifeContext, house: HouseRecord, carriedBox?: number) {
  const { session } = ctx;
  let storage = house.storage;
  if (storage && !session.world.entities.has(storage)) storage = undefined;
  if (!storage && carriedBox) {
    await session.dropAtFeet(carriedBox).catch(() => {});
    session.say('i wish to secure this');
    await session.waitFor(() => session.world.target !== null, 'secure cursor', 4000).catch(() => {});
    if (session.world.target) {
      session.target({ serial: carriedBox, ...ctx.position(), graphic: BOX });
      await Bun.sleep(1500);
      updateHouse(house.owner, { storage: carriedBox });
      storage = carriedBox;
    }
  }
  if (!storage) return;
  const box = session.world.entities.get(storage);
  if (!box?.position || distance(ctx.position(), box.position) > 2) return;
  const keep = new Set(ctx.checkpoint.keep ?? []);
  const valuables = session.world
    .childrenOf(backpackOf(ctx))
    .filter((i) => i.graphic !== gold && (keep.has(i.serial) || ['artifact', 'magic'].includes(quality(i))));
  for (const item of valuables.slice(0, 20)) {
    await session.moveItem(item.serial, storage).catch(() => {});
    if (keep.has(item.serial)) ctx.checkpoint.keep = (ctx.checkpoint.keep ?? []).filter((s) => s !== item.serial);
  }
  if (valuables.length) {
    ctx.log(`Stored ${Math.min(20, valuables.length)} valuables at home`);
    ctx.persist();
  }
}
