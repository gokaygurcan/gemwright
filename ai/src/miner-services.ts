import { chargedPurchase, openBankBox, queryBankBalance } from './bank-gold';
import { Blocked } from './blocked';
import { bestRecipe, RAW_INGOT_VALUE } from './miner-crafting';
import { createIngotSeller } from './miner-selling';
import { approachVendor } from './mobile-approach';
import type { createNavigator } from './navigation';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position, WorldView } from './protocol/world';
import { createServiceExperience } from './service-experience';
import { skillId } from './skills';
import type { Checkpoint } from './store';
import type { Terrain } from './terrain';
import { buyFrom } from './vendor-trade';

export const tools = new Set([0x0e85, 0x0e86, 0x0f39, 0x0f3a]);
export const ingot = 0x1bf2;
export const forges = new Set([0x0fb1, ...Array.from({ length: 48 }, (_, index) => 6522 + index)]);

export interface MinerProgress {
  smelts: number;
  ingotsProduced: number;
  deposits: number;
  trips: number;
  purchases: number;
  sold: number;
  packRejected: boolean;
}

export function createMinerServices(ctx: {
  session: PlayerSession;
  serial: number;
  terrain: Terrain;
  checkpoint: Checkpoint;
  blocked: Set<string>;
  city: string;
  banks: readonly { x: number; y: number }[];
  shops: readonly { x: number; y: number }[];
  position: () => Position;
  status: () => NonNullable<WorldView['status']>;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  navigate: ReturnType<typeof createNavigator>;
  carried: (backpack: number) => Entity[];
  smeltable: (backpack: number) => Entity[];
  retainedOre: (backpack: number) => Entity[];
  unsmeltable: Set<number>;
  plan: () => NonNullable<Checkpoint['mining']>;
  newTrip: () => NonNullable<Checkpoint['mining']>;
  progress: MinerProgress;
  persist: () => void;
}) {
  const {
    session,
    terrain,
    checkpoint,
    blocked,
    city,
    banks,
    shops,
    position,
    status,
    check,
    phase,
    log,
    navigate,
    carried,
    smeltable,
    retainedOre,
    unsmeltable,
    plan,
    newTrip,
    progress
  } = ctx;
  const learning = createServiceExperience(ctx);
  const smelt = async (backpack: number) => {
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
          [0x190, 0x191, 0x25d, 0x25e].includes(mobile.graphic) &&
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
  const findBanker = async () => {
    const observedBanker = async () => {
      for (const mobile of learning.order([...session.world.entities.values()], 3006105)) {
        if (!mobile.position || distance(position(), mobile.position) > 12 || learning.blocked(mobile, 3006105))
          continue;
        check();
        try {
          const menu = await session.context(mobile.serial);
          const entry = menu.find((item) => item.cliloc === 3006105 && !(item.flags & 1));
          if (entry) return { serial: mobile.serial, index: entry.index };
        } catch (error) {
          if (session.phase !== 'ready') throw error;
        }
      }
      return undefined;
    };
    const nearby = await observedBanker();
    if (nearby) return nearby;
    for (const point of [...banks].sort((a, b) => distance(position(), a) - distance(position(), b))) {
      phase('bank-travel', `Travelling to ${city} bank at ${point.x},${point.y}`);
      try {
        await navigate(point, 3);
      } catch (error) {
        check();
        if (!(error instanceof Blocked)) throw error;
        log(`Bank approach blocked: ${error.message}`);
      }
      phase('bank-open', 'Looking for a nearby banker with an enabled open-bank context entry');
      const banker = await observedBanker();
      if (banker) return banker;
    }
    throw new Blocked('no-vendor', 'No reachable banker offered an enabled bank action');
  };
  const sellIngots = createIngotSeller(ctx, learning);
  const bank = async (backpack: number) => {
    plan().pending = 'bank';
    await sellIngots(backpack);
    const banker = await findBanker();
    const box = { serial: await openBankBox(ctx, banker.serial) };
    await Bun.sleep(500);
    phase('bank-deposit', 'Depositing observed ingots through ordinary lift/drop requests');
    // Ore the forge refused would otherwise pin the pack at its weight limit with no way to mine.
    const retained = new Set(retainedOre(backpack).map((item) => item.serial));
    for (const item of [...session.world.entities.values()]) {
      // Gold is deposited too: vendors charge the bank, and carried gold is lost on death.
      const kept = !!checkpoint.keep?.includes(item.serial);
      if (
        item.parent !== backpack ||
        (item.graphic !== ingot && item.graphic !== 0xeed && !retained.has(item.serial) && !kept)
      )
        continue;
      check();
      await session.moveItem(item.serial, box.serial);
      if (kept) checkpoint.keep = checkpoint.keep?.filter((serial) => serial !== item.serial);
      if (item.graphic === ingot) progress.deposits += item.amount ?? 1;
      await Bun.sleep(700);
    }
    checkpoint.stock = {
      ingots: [...session.world.entities.values()]
        // Iron only (hue 0): colored ingots are kept, never sold, and must not trigger iron sales.
        .filter((item) => item.parent === box.serial && item.graphic === ingot && !item.hue)
        .reduce((sum, item) => sum + (item.amount ?? 1), 0),
      at: Date.now()
    };
    await queryBankBalance({ ...ctx, checkpoint }, banker.serial);
    const confirmedBanker = session.world.entities.get(banker.serial);
    if (confirmedBanker) learning.record(confirmedBanker, 3006105, 'success');
    progress.trips++;
    checkpoint.mining = newTrip();
    await session.refreshStatus();
    phase('bank-complete', `Confirmed bank trip ${progress.trips}; deposited ${progress.deposits} ingots this run`);
  };
  // Takes up to `most` banked iron ingots, at least `least`; false when the bank holds too few.
  const withdrawIngots = async (backpack: number, least: number, most: number) => {
    if ((checkpoint.stock?.ingots ?? 0) < least) return false;
    const banker = await findBanker();
    const box = await openBankBox(ctx, banker.serial);
    await Bun.sleep(500);
    const stack = [...session.world.entities.values()]
      .filter((item) => item.parent === box && item.graphic === ingot && !item.hue)
      .sort((a, b) => (b.amount ?? 1) - (a.amount ?? 1))[0];
    if (!stack || (stack.amount ?? 1) < least) {
      if (checkpoint.stock) checkpoint.stock = { ingots: stack?.amount ?? 0, at: Date.now() };
      return false;
    }
    const amount = Math.min(stack.amount ?? 1, most);
    phase('bank-withdraw', `Taking ${amount} banked iron ingots to work`);
    await session.moveItem(stack.serial, backpack, amount);
    if (checkpoint.stock) checkpoint.stock = { ingots: (checkpoint.stock.ingots ?? 0) - amount, at: Date.now() };
    ctx.persist();
    return true;
  };
  // With every nearby vein worked out, a smith turns banked iron into goods instead of standing idle.
  // Short of banked iron, a recipe paying more than the vendor's 5 gold an ingot (SBBlacksmith) is
  // worth buying the metal for.
  const smithFromBank = async (backpack: number) => {
    const recipe = bestRecipe(session.world.skills.get(skillId('Blacksmith'))?.base ?? 0);
    if (!recipe || recipe.perIngot <= RAW_INGOT_VALUE) return false;
    if ((checkpoint.stock?.ingots ?? 0) < recipe.ingots) {
      if (recipe.perIngot <= 5) return false;
      phase(
        'buy-ingots',
        `Buying iron from the smith for ${recipe.name}s (${recipe.perIngot.toFixed(1)} gold an ingot)`
      );
      if (!(await buyFrom({ ...ctx, backpack: () => backpack }, 'blacksmith', new Map([[0x1bf2, 16]]), 5)))
        return false;
    } else if (!(await withdrawIngots(backpack, recipe.ingots, recipe.ingots * 8))) return false;
    const sold = progress.sold;
    await sellIngots(backpack, true);
    return progress.sold > sold;
  };
  const resupply = async (backpack: number) => {
    const count = () =>
      [...session.world.entities.values()].filter((item) => item.parent === backpack && tools.has(item.graphic)).length;
    if (count() >= 2) return;
    try {
      await buyTool(backpack, count);
    } catch (error) {
      // A spare tool is optional; keep mining with the carried one when the shop route fails legally.
      if (!(error instanceof Blocked) || count() === 0) throw error;
      log(`Spare tool unavailable (${error.reason}): ${error.message}; continuing with the carried tool`);
    }
  };
  const buyTool = async (backpack: number, count: () => number) => {
    phase('resupply', 'Looking for an ordinary vendor selling a spare mining tool, up to 100 gold');
    const inspected = new Set<number>();
    for (const landmark of [position(), ...shops]) {
      await navigate(landmark, 3);
      for (const mobile of learning.order([...session.world.entities.values()], 3006103, [...tools])) {
        if (
          mobile.kind !== 'mobile' ||
          mobile.serial === session.world.serial ||
          !mobile.position ||
          distance(position(), mobile.position) > 8 ||
          inspected.has(mobile.serial)
        )
          continue;
        check();
        inspected.add(mobile.serial);
        if (learning.blocked(mobile, 3006103, [...tools])) continue;
        let menu: Awaited<ReturnType<PlayerSession['context']>>;
        try {
          menu = await session.context(mobile.serial);
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          else continue;
        }
        const buy = menu.find((entry) => entry.cliloc === 3006103 && !(entry.flags & 1));
        if (!buy) continue;
        try {
          await approachVendor(ctx, mobile.serial);
        } catch (error) {
          check();
          learning.record(mobile, 3006103, 'unreachable');
          log(`Tool vendor approach unavailable: ${error instanceof Error ? error.message : 'unknown obstruction'}`);
          continue;
        }
        const freshBuy = (await session.context(mobile.serial)).find(
          (entry) => entry.cliloc === 3006103 && !(entry.flags & 1)
        );
        if (!freshBuy) continue;
        session.world.buyOffers.clear();
        const before = session.world.received.get(0x74) ?? 0;
        session.selectContext(mobile.serial, freshBuy.index);
        try {
          await session.waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'vendor stock', 2500);
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          else continue;
        }
        const offer = [...session.world.buyOffers.values()]
          .flat()
          .filter((entry) => {
            const item = session.world.entities.get(entry.serial);
            const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            return (
              stock?.parent === mobile.serial &&
              item &&
              tools.has(item.graphic) &&
              (item.amount ?? 0) > 0 &&
              entry.price > 0 &&
              entry.price <= 100
            );
          })
          .sort((a, b) => a.price - b.price)[0];
        if (!offer) {
          const stocked = [...session.world.buyOffers.values()].flat().some((entry) => {
            const item = session.world.entities.get(entry.serial);
            const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
            return item && stock?.parent === mobile.serial && tools.has(item.graphic) && (item.amount ?? 0) > 0;
          });
          if (!stocked) learning.record(mobile, 3006103, 'no-stock', [...tools]);
          continue;
        }
        phase(
          'resupply-purchase',
          `Buying one mining tool from observed vendor ${mobile.serial} for ${offer.price} gold`
        );
        await approachVendor(ctx, mobile.serial);
        // The vendor charges carried gold, then this character's bank balance; a refusal is a Blocked outcome.
        await chargedPurchase({ ...ctx, backpack: () => backpack }, offer.price, () =>
          session.purchaseItem(mobile.serial, offer.serial, backpack, 1, 100)
        );
        learning.record(mobile, 3006103, 'success', [...tools]);
        progress.purchases++;
        phase('resupply-complete', 'Confirmed the purchased tool in the backpack');
        return;
      }
    }
    throw new Blocked(
      count() ? 'no-vendor' : 'missing-tool',
      'No stocked mining-tool vendor found along the current Britain shop route'
    );
  };
  return { smelt, bank, resupply, smithFromBank, withdrawIngots };
}
