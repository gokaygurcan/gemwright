import { Notoriety } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';

import { absence } from './absence';
import { ActionBusy } from './action-errors';
import { withinReach } from './areas';
import { Blocked } from './blocked';
import type { CraftContext } from './craft-training';
import { moongates, nearestGate } from './gates';
import { allServiceLocations, type ServiceType, serviceLocations, townAt, vendorLocations } from './locations';
import { approachVendor } from './mobile-approach';
import { travelByMoongate } from './moongate';
import { distance } from './navigation';
import { completeObjective, failObjective, objectiveBlocked, suppliesCondition } from './objective-memory';
import { reachableFrom } from './unreachable';
import { cityAllowed } from './world';

// One vendor interaction (Actions.buy buy, Actions.sell sell) at the first stop where it succeeds.
export async function atVendor(
  ctx: CraftContext,
  vendorType: ServiceType,
  cliloc: number,
  act: (vendor: number) => Promise<boolean>,
  objective = 'service'
) {
  const { session, navigate, position } = ctx;
  const town = townAt(position(), ctx.city);
  // A town without this kind of shop (Yew has no tinker) sends the crafter to the nearest ones.
  const own = serviceLocations(town, vendorType);
  const alternatives = allServiceLocations(vendorType)
    .filter((shop) => cityAllowed(shop.city) && !own.some((point) => point.x === shop.x && point.y === shop.y))
    .sort((a, b) => distance(position(), a) - distance(position(), b));
  // Shops in walking reach only; a moongate trip to a far town's shop only for one who can pay
  // for what it goes for, and only the nearest such town. Nobody crosses the land on a hunch.
  const funds = (ctx.status().gold ?? 0) + (ctx.checkpoint.funds?.bank ?? 0);
  const walkable = alternatives.filter((shop) => distance(position(), shop) <= 300);
  const stops = [...own.filter((shop) => distance(position(), shop) <= 300 || funds >= 100), ...walkable.slice(0, 2)];
  // When none of this town's shops serves the need, the nearest other towns' shops are still worth
  // one trip: a fisher whose town's fishmonger cannot trade has nothing left to stay for. Selling
  // always travels (it is how the resident earns); buying only when it can pay for more than the
  // trip itself.
  const elsewhere =
    cliloc === Actions.sell || funds >= 100
      ? alternatives.filter((shop) => !stops.some((stop) => stop.x === shop.x && stop.y === shop.y)).slice(0, 3)
      : [];
  // The shop landmark is the door; the vendor stands somewhere inside or beside it. The spawner data
  // (the shard's vendor spawners, locations.ts) lists where each kind of vendor actually appears in this town. A town
  // whose shops all failed this objective lately teaches nothing new: its spawn points wait too.
  const objectiveKey = (x: number, y: number) =>
    `shop:${session.world.map}:${vendorType}:${cliloc}:${x},${y}:${objective}`;
  const townBlocked =
    own.length > 0 &&
    own.every((shop) =>
      objectiveBlocked(ctx.checkpoint, objectiveKey(shop.x, shop.y), suppliesCondition(session, ctx.checkpoint))
    );
  const spawns = townBlocked
    ? []
    : vendorLocations(town, vendorType)
        .filter((point) => !stops.some((stop) => distance(stop, point) <= 3))
        .sort((a, b) => distance(position(), a) - distance(position(), b));
  // A vendor that answered before is the surest place to look again (kept for a day).
  const vendorKey = `${session.world.map ?? -1}:${town.toLowerCase()}:${vendorType}`;
  const remembered = ctx.checkpoint.landmarks?.vendors?.[vendorKey];
  const learn = (at: { x: number; y: number; z: number }) => {
    ctx.checkpoint.landmarks ??= { forges: [] };
    ctx.checkpoint.landmarks.vendors ??= {};
    ctx.checkpoint.landmarks.vendors[vendorKey] = { x: at.x, y: at.y, z: at.z, at: Date.now() };
    ctx.persist?.();
  };
  const planned = [
    ...(remembered && !townBlocked && Date.now() - remembered.at < 86_400_000
      ? [{ point: remembered, inTown: true }]
      : []),
    ...stops.map((point) => ({ point, inTown: own.some((shop) => shop.x === point.x && shop.y === point.y) })),
    ...spawns.map((point) => ({ point, inTown: true }))
  ];
  // What is standing within sight that sells or buys this: a vendor the catalogue never knew about —
  // a shop somebody added to the docks — is found by its menu, not by its address, and then
  // remembered (learn) for the next visit. Tried in town, before any trip to another town.
  const observed = [...session.world.entities.values()]
    .filter(
      (mobile) =>
        mobile.kind === 'mobile' &&
        mobile.notoriety === Notoriety.invulnerable &&
        mobile.position &&
        distance(position(), mobile.position) <= 60 &&
        !planned.some((visit) => distance(visit.point, mobile.position as { x: number; y: number }) <= 3)
    )
    .sort(
      (a, b) =>
        distance(position(), a.position as { x: number; y: number }) -
        distance(position(), b.position as { x: number; y: number })
    )
    .slice(0, 4)
    .map((mobile) => ({ point: mobile.position as { x: number; y: number; z: number }, inTown: true }));
  const visits = [...planned, ...observed, ...elsewhere.map((point) => ({ point, inTown: false }))];
  // Once this town's vendor answers with nothing for this objective, its other spawn points teach
  // nothing more on this visit; other towns are still tried.
  let townSettled = false;
  for (const { point: shop, inTown } of visits) {
    if (inTown && townSettled) continue;
    ctx.check();
    const key = objectiveKey(shop.x, shop.y);
    const condition = suppliesCondition(session, ctx.checkpoint);
    // A shop is where a vendor may be, not where it is: one found empty stays empty in memory for a
    // while (absence.ts; towns.ts counts it against the town), whatever the resident carries.
    const absent = absence(session.world.serial ?? -1);
    if (absent.seen('vendor', shop, vendorType)) continue;
    if (
      objectiveBlocked(ctx.checkpoint, key, condition) &&
      !ctx.checkpoint.objectives?.[key]?.reason?.startsWith('Too heavy')
    ) {
      ctx.log(`Trying another ${vendorType}: ${ctx.checkpoint.objectives?.[key]?.reason}`);
      continue;
    }
    if ((distance(position(), shop) < 300 && !reachableFrom(shop, position())) || !withinReach(position(), shop))
      continue;
    try {
      const gate = nearestGate(shop);
      if (distance(position(), shop) > 300 && distance(position(), moongates[gate]) > 2)
        await travelByMoongate(ctx, gate);
      await navigate(shop, 4);
      let heard = false;
      // Why each menu failed: busy (our own resource) and no reply say nothing about the shop;
      // only menus that came back without the service do.
      const why = { busy: 0, silent: 0, without: 0 };
      const menu = async (serial: number) => {
        try {
          const entries = await session.context(serial);
          const entry = entries.find((e) => e.cliloc === cliloc && !(e.flags & 1));
          if (!entry) why.without++;
          return entry;
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          if (error instanceof ActionBusy) why.busy++;
          else why.silent++;
        }
      };
      for (const mobile of [...session.world.entities.values()]) {
        if (mobile.kind !== 'mobile' || mobile.notoriety !== Notoriety.invulnerable || !mobile.position) continue;
        if (distance(position(), mobile.position) > 18) continue;
        // The shard answers a menu only within its update range and vendors wander: a request that
        // goes unanswered is retried from close range before another vendor is tried.
        let entry = await menu(mobile.serial);
        if (entry === undefined) {
          await approachVendor(ctx, mobile.serial).catch(() => {});
          entry = await menu(mobile.serial);
        }
        if (entry === undefined) continue;
        heard = true;
        await approachVendor(ctx, mobile.serial);
        if (await act(mobile.serial)) {
          completeObjective(ctx.checkpoint, key);
          learn(mobile.position);
          return true;
        }
      }
      if (!heard) {
        const reasons = `busy ${why.busy}, no reply ${why.silent}, menu without it ${why.without}`;
        // Inconclusive (our own resource busy, or a request unanswered): nothing learned, no ban.
        if (why.busy || why.silent) {
          ctx.log(`No ${vendorType} heard near ${shop.x},${shop.y} (${reasons}); trying again later`);
          continue;
        }
        // Conclusive: nobody there, or every vendor there answered without it. Vendors wander out
        // of reach or die: a first miss holds a while, a second soon after longer.
        const minutes = absent.note('vendor', shop, vendorType);
        ctx.log(`No ${vendorType} near ${shop.x},${shop.y} (${reasons}); not looking there for ${minutes} minutes`);
        continue;
      }
      townSettled ||= inTown;
      failObjective(
        ctx.checkpoint,
        key,
        suppliesCondition(session, ctx.checkpoint),
        'No usable stock, affordable offer or matching service'
      );
    } catch (error) {
      ctx.check();
      // Too heavy to walk is about the pack, not the shop: the resident lightens it first.
      if (!(error instanceof Blocked) || error.reason === 'overweight') throw error;
      failObjective(ctx.checkpoint, key, condition, error.message);
      ctx.log(`Trying another ${vendorType}: ${error.message}`);
    }
  }
  return false;
}
