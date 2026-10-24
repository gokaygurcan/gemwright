import { PLAIN_HUMAN_BODIES } from '@gemwright/common/bodies';

import { fundsStale, queryBankBalance, spendableGold } from './bank-gold';
import { allServiceLocations, serviceLocations } from './locations';
import { approachVendor } from './mobile-approach';
import { canAffordMount, horseBodies, type MountContext, type MountMemory } from './mount-types';
import { distance } from './navigation';
import type { Entity } from './protocol/world';
import { createServiceExperience } from './service-experience';
import { reachRegion } from './work-areas';

// `animal` picks what the trainer sells: riding horses by default, pack animals for gatherers
// (pack-animal.ts); `memory.horse` holds whichever animal the memory is for.
export function createMountServices(
  ctx: MountContext,
  city: string,
  reserve: number,
  animal: { bodies: ReadonlySet<number>; name: string } = { bodies: horseBodies, name: 'horse' }
) {
  const { session, position, check, navigate, phase, persist, log } = ctx;
  const learning = createServiceExperience(ctx);
  const spendable = () => spendableGold(session, ctx.backpack(), ctx.checkpoint);
  const mobiles = () =>
    [...session.world.entities.values()].filter(
      (mobile) =>
        mobile.kind === 'mobile' &&
        PLAIN_HUMAN_BODIES.has(mobile.graphic) &&
        mobile.position &&
        distance(position(), mobile.position) <= 16
    );
  // The trainer charges carried gold, then the bank balance, so funding only needs a current balance.
  const fund = async () => {
    if (!fundsStale(ctx.checkpoint)) return;
    for (const bank of serviceLocations(city, 'banker')) {
      await navigate(bank, 4);
      for (const mobile of learning.order(mobiles(), 3006105)) {
        check();
        if (learning.blocked(mobile, 3006105)) continue;
        let menu: Awaited<ReturnType<typeof session.context>>;
        try {
          menu = await session.context(mobile.serial);
        } catch {
          check();
          continue;
        }
        if (!menu.some((entry) => entry.cliloc === 3006105)) continue;
        await queryBankBalance(ctx, mobile.serial);
        learning.record(mobile, 3006105, 'success');
        return;
      }
    }
  };
  const approachTrainer = async (vendor: Entity) => {
    try {
      await approachVendor(ctx, vendor.serial);
      return true;
    } catch (error) {
      check();
      learning.record(vendor, 3006103, 'unreachable', [0xcc]);
      log(`Trainer approach unavailable: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  };
  const purchase = async (
    memory: MountMemory,
    discover: (excluded: readonly number[]) => Promise<Entity | undefined>
  ) => {
    if (memory.pending || memory.horse) return;
    // The follower count proves whether an animal this memory has lost track of still exists:
    // more followers than the known horse and pack animal means it is alive somewhere, so it is
    // found, never replaced. A tamer's companion takes an unknown number of slots, so it is skipped.
    const known = (() => {
      const { mount, packAnimal, companion } = ctx.checkpoint;
      if (companion) return undefined;
      const horse = mount?.horse !== undefined || mount?.state === 'riding' ? 1 : 0;
      const pack = packAnimal?.horse !== undefined ? 1 : 0;
      // A pack animal given up as lost (pack-animal.ts) still counts as a follower somewhere.
      return animal.bodies === horseBodies ? pack : horse + (packAnimal?.abandoned ?? 0);
    })();
    await session.refreshStatus();
    const followers = ctx.status().followers;
    if (followers === undefined || (known !== undefined && followers > known)) {
      memory.state = 'missing';
      memory.retryAfter = Date.now() + 10 * 60_000;
      memory.note = `My ${animal.name} still counts as a follower; finding it instead of buying another`;
      persist();
      log(memory.note);
      return;
    }
    await fund();
    if (spendable() <= reserve) {
      memory.retryAfter = Date.now() + 5 * 60_000;
      memory.note = `Saving earned gold for a ${animal.name} while retaining working funds`;
      persist();
      return;
    }
    // Why no animal was bought, reported when the attempt ends without one.
    let why = `no animal trainer near the ${city} stables offered a ${animal.name}`;
    // The home city's stables, or, in a town without any (Yew, Moonglow, Vesper, Jhelom, Magincia),
    // the nearest towns that have them, reached by moongate when far, as a player would.
    const own = serviceLocations(city, 'animal-trainer');
    const stops = own.length
      ? own
      : allServiceLocations('animal-trainer')
          .sort((a, b) => distance(position(), a) - distance(position(), b))
          .slice(0, 3);
    for (const stop of stops) {
      phase('mount-trainer', `Looking for an animal trainer near ${stop.name}`);
      try {
        await reachRegion(ctx, stop);
        await navigate(stop, 4);
      } catch (error) {
        check();
        log(`Stable route unavailable: ${error instanceof Error ? error.message : error}`);
        why = `the ${stop.name} stables were unreachable`;
        continue;
      }
      for (const vendor of learning.order(mobiles(), 3006103, [0xcc])) {
        check();
        if (learning.blocked(vendor, 3006103, [0xcc])) continue;
        let menu: Awaited<ReturnType<typeof session.context>>;
        try {
          menu = await session.context(vendor.serial);
        } catch {
          check();
          continue;
        }
        if (!menu.some((entry) => entry.cliloc === 3006126)) continue;
        if (!(await approachTrainer(vendor))) {
          why = `could not get next to the trainer ${vendor.name ?? vendor.serial}`;
          continue;
        }
        menu = await session.context(vendor.serial);
        const buy = menu.find((entry) => entry.cliloc === 3006103 && !(entry.flags & 1));
        if (!buy) continue;
        session.world.buyOffers.clear();
        const beforeStock = session.world.received.get(0x74) ?? 0;
        session.selectContext(vendor.serial, buy.index);
        await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > beforeStock, 'trainer stock', 3000);
        const offers = [...session.world.buyOffers.values()]
          .flat()
          .filter((offer) => {
            const item = session.world.entities.get(offer.serial);
            const pack = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            return item && pack?.parent === vendor.serial && animal.bodies.has(item.graphic) && (item.amount ?? 0) > 0;
          })
          .sort((a, b) => a.price - b.price);
        if (!offers.length) {
          learning.record(vendor, 3006103, 'no-stock', [0xcc]);
          why = `${vendor.name ?? 'the trainer'} had no ${animal.name} in stock`;
          continue;
        }
        const offer = offers.find((offer) => canAffordMount(offer.price, spendable(), reserve));
        if (!offer) {
          why = `the cheapest ${animal.name} costs ${offers[0]?.price} gold; ${spendable()} spendable with ${reserve} kept back`;
          continue;
        }
        await session.refreshStatus();
        if (
          ctx.status().followers === undefined ||
          ctx.status().maxFollowers === undefined ||
          (ctx.status().followers ?? 0) >= (ctx.status().maxFollowers ?? 0)
        ) {
          memory.note = `No confirmed free follower slot for a ${animal.name}`;
          memory.retryAfter = Date.now() + 5 * 60_000;
          persist();
          return;
        }
        if (!(await approachTrainer(vendor))) continue;
        memory.state = 'purchase-pending';
        delete memory.lastSeen;
        memory.pending = {
          vendor: vendor.serial,
          stock: offer.serial,
          price: offer.price,
          at: Date.now(),
          map: session.world.map ?? 1,
          ...position(),
          before: [...session.world.entities.values()]
            .filter((e) => e.kind === 'mobile' && animal.bodies.has(e.graphic))
            .map((e) => e.serial)
            .slice(0, 128)
        };
        phase(
          'mount-purchase',
          `Buying one ${animal.name} for ${offer.price} gold; retaining at least ${reserve} gold`
        );
        const before = new Set(session.world.journal);
        const rejected = () =>
          session.world.journal.find(
            (entry) =>
              !before.has(entry) &&
              entry.serial === vendor.serial &&
              [500190, 500187, 500191, 500192].includes(entry.cliloc ?? 0)
          );
        await session.purchaseAnimal(vendor.serial, offer.serial, spendable() - reserve);
        // The charge may come from the bank; require a fresh balance before the next spend.
        delete ctx.checkpoint.funds;
        try {
          await session.waitFor(
            () =>
              rejected() !== undefined ||
              [...session.world.entities.values()].some(
                (e) =>
                  e.kind === 'mobile' &&
                  animal.bodies.has(e.graphic) &&
                  e.position &&
                  distance(position(), e.position) <= 2 &&
                  !memory.pending?.before.includes(e.serial)
              ),
            `purchased ${animal.name} delivery`,
            5000
          );
          const horse = await discover(memory.pending.before);
          if (horse) {
            learning.record(vendor, 3006103, 'success', [0xcc]);
            return;
          }
          if (rejected()) {
            delete memory.pending;
            memory.state = 'seeking';
            memory.note = `Server rejected the ${animal.name} purchase`;
          } else
            memory.note = `${animal.name} purchase delivery or ownership remains uncertain; no automatic repeat purchase`;
        } catch (error) {
          check();
          log(`${animal.name} purchase awaits reconciliation: ${error instanceof Error ? error.message : error}`);
        }
        persist();
        return;
      }
    }
    memory.retryAfter = Date.now() + 5 * 60_000;
    memory.note = `No ${animal.name} bought: ${why}`;
    log(memory.note);
    persist();
  };
  return { purchase };
}
