import { tally } from './activity';
import { chargedPurchase, offersBank, openBankBox, queryBankBalance } from './bank-gold';
import type { CharacterTemplate } from './config';
import { converse } from './conversation';
import type { DecisionCoordinator } from './decisions';
import { lifeTurn } from './life';
import { serviceLocations } from './locations';
import { treeStatics } from './lumber-trees';
import { approachVendor } from './mobile-approach';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator, distance } from './navigation';
import { createPackAnimal } from './pack-animal';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';
import { noticePeers } from './relationships';
import { isGhost, resurrectGhost } from './resurrection';
import { scavenge } from './scavenge';
import { isSetback, passSetback } from './setback';
import { trainSupportingSkill } from './skill-training';
import type { Checkpoint } from './store';
import { Terrain } from './terrain';
import { reachRegion, workArea } from './work-areas';

const log = 0x1bdd;
const board = 0x1bd7;
const woodSet = new Set([board]);
const hatchets = new Set([0x0f43, 0x0f44, 0x0f47, 0x0f48, 0x0f49, 0x0f4a, 0x13fa, 0x13fb]);
// Lumberjacking.cs replies: AOS resource messages 1072540-1072546 or the classic 500498 on
// success, 500495 on a failed chop, 500493 depleted tree, 500446 too far, 500497 pack full,
// 500499 broken axe.
const CHOPPED = [500498, 1072540, 1072541, 1072542, 1072543, 1072544, 1072545, 1072546];
const FAILED = 500495;
const DEPLETED = [500493, 500446, 500494];
const PACK_FULL = 500497;
const BROKE = 500499;
// Trees regrow 20-30 minutes after depletion (Lumberjacking.cs MinRespawn/MaxRespawn).
const REGROW = 30 * 60_000;
// Boards are the vendor economy item (75% of 3 gold = 2); logs sell for 1. Every carpentry item and,
// below Bowcraft 65, every bow is worth less per piece of wood than the boards themselves, so the
// best value is to cut logs into boards (1:1, half the weight, no skill needed) and sell those.

export async function runLumberjack(options: {
  session: PlayerSession;
  assets: string;
  template: CharacterTemplate;
  seconds: number;
  peers?: ReadonlyMap<number, string>;
  label?: string;
  checkpoint: Checkpoint;
  decisions?: DecisionCoordinator;
  save: (checkpoint: Checkpoint) => void;
  stopping?: () => boolean;
}) {
  const { session, template } = options;
  // Each lumberjack works its own woods (work-areas.json) and sells in that city.
  const woods = workArea('woods', options.label ?? template.id);
  const city = woods.city.toLowerCase();
  const serial = session.world.serial;
  if (serial === null || session.world.map !== 1) throw new Error('The lumberjack supports Trammel Britain');
  const terrain = Terrain.shared(options.assets, 1);
  const deadline = Date.now() + options.seconds * 1000;
  const checkpoint = structuredClone(options.checkpoint);
  checkpoint.landmarks ??= { forges: [] };
  const progress = { chops: 0, logs: 0, boards: 0, sold: 0, earned: 0, trips: 0 };
  const tag = options.label ? `lumberjack:${options.label}` : 'lumberjack';
  const say = (message: string) => console.error(`[${tag}] ${message}`);
  const persist = () => options.save(checkpoint);
  const phase = (value: string, note: string) => {
    checkpoint.goal = { kind: 'lumberjacking', phase: value };
    noticePeers(session, checkpoint, options.peers, template.behavior.sociability);
    void converse({ session, checkpoint, template, city, peers: options.peers, decisions: options.decisions });
    checkpoint.memories = [...checkpoint.memories.slice(-49), { at: new Date().toISOString(), text: note }];
    persist();
    say(`${value}: ${note}`);
  };
  const position = () => {
    if (!session.world.position) throw new Error('Position is unknown');
    return session.world.position;
  };
  const status = () => {
    if (!session.world.status) throw new Error('Status is unknown');
    return session.world.status;
  };
  const check = () => {
    if (options.stopping?.() || Date.now() >= deadline) throw new Error('Lumberjack run duration reached');
    if (session.phase !== 'ready') throw new Error('Lumberjack disconnected; reconnect before continuing');
  };
  const setback = (reason: string) =>
    passSetback(
      {
        session,
        check,
        phase,
        log: say,
        deadline,
        archetype: template.archetype,
        items: () => [...session.world.childrenOf(serial), ...carried()]
      },
      reason
    );
  // A craftsman supporting skill: Arms Lore on the hatchet, Carpentry with carried boards, and so on.
  const practise = async () => {
    const until = Math.min(deadline, Date.now() + (2 + Math.random() * 3) * 60_000);
    await trainSupportingSkill({
      session,
      check,
      phase,
      log: say,
      until,
      archetype: template.archetype,
      items: () => [...session.world.childrenOf(serial), ...carried()],
      // Carpentry uses the boards already carried; Magery and Tinkering buy from Britain vendors.
      shop: {
        session,
        serial,
        terrain,
        position,
        navigate,
        check,
        phase,
        log: say,
        checkpoint,
        status,
        city,
        carried: () => carried(),
        backpack: backpackSerial
      }
    });
  };
  const blocked = new Set<string>();
  let mounts: ReturnType<typeof createMountController> | undefined;
  let packs: ReturnType<typeof createPackAnimal> | undefined;
  const heavy = () => status().weight >= status().maxWeight * template.behavior.bankAtWeightRatio;
  const groundNavigate = createNavigator({ session, terrain, check, phase, log: say, blocked });
  const navigate = mountedNavigator(groundNavigate, () => mounts, undefined, position);
  const backpackSerial = () => {
    const pack = session.world.childrenOf(serial).find((item) => item.layer === Layer.Backpack);
    if (!pack) throw new Error('No observed backpack');
    return pack.serial;
  };
  const carried = () => session.world.childrenOf(backpackSerial());
  const count = (graphic: number) =>
    carried()
      .filter((item) => item.graphic === graphic && !item.hue)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const tool = () =>
    [...session.world.entities.values()].find(
      (item) => hatchets.has(item.graphic) && (item.parent === serial || item.parent === backpackSerial())
    );
  // Depleted trees, shared with the miner's persisted depletion list and its expiry.
  const depleted = new Map((checkpoint.landmarks.depleted ?? []).map((entry) => [entry.key, entry.until]));
  const deplete = (key: string) => {
    depleted.set(key, Date.now() + REGROW);
    if (checkpoint.landmarks)
      checkpoint.landmarks.depleted = [...depleted]
        .filter(([, until]) => until > Date.now())
        .slice(-300)
        .map(([key, until]) => ({ key, until }));
    persist();
  };
  const people = () =>
    [...session.world.entities.values()].filter(
      (mobile) => mobile.kind === 'mobile' && mobile.serial !== serial && [0x190, 0x191].includes(mobile.graphic)
    );

  // Uses the hatchet on carried logs: the whole stack becomes boards (Log.Axe, no skill required).
  const cutBoards = async () => {
    const pile = carried().find((item) => item.graphic === log && !item.hue);
    const axe = tool();
    if (!pile || !axe) return;
    phase('cutting-boards', `Cutting ${pile.amount ?? 1} logs into boards`);
    const before = count(board);
    session.use(axe.serial);
    await session.waitFor(() => session.world.target !== null, 'hatchet cursor', 4000);
    session.target({ serial: pile.serial, x: 0, y: 0, z: 0, graphic: pile.graphic });
    await session.waitFor(() => count(board) > before || !session.world.entities.has(pile.serial), 'boards', 5000);
    progress.boards += count(board) - before;
  };

  const vendorMenu = async (mobile: Entity, cliloc: number) =>
    (mobile.notoriety === 7 ? await session.context(mobile.serial).catch(() => []) : []).find(
      (entry) => entry.cliloc === cliloc && !(entry.flags & 1)
    );

  // Town trip: sell boards to the carpenter, bank the gold, replace a broken hatchet.
  const town = async () => {
    await cutBoards();
    const carpenter = serviceLocations(city, 'carpenter')[0];
    // Pack animal boards sell a load at a time.
    const room = () => status().maxWeight - 20 - status().weight;
    for (let load = 0; load < 20; load++) {
      if (carpenter && count(board) > 0) {
        phase('selling', `Taking ${count(board)} boards to the carpenter`);
        await navigate(carpenter, 4);
        for (const mobile of [...session.world.entities.values()]) {
          if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
          const entry = await vendorMenu(mobile, 3006104);
          if (!entry) continue;
          await approachVendor({ session, terrain, position, navigate, check, serial }, mobile.serial);
          session.world.sellOffers.delete(mobile.serial);
          const current = await vendorMenu(mobile, 3006104);
          if (!current) continue;
          session.selectContext(mobile.serial, current.index);
          const offered = await session
            .waitFor(() => session.world.sellOffers.has(mobile.serial), 'carpenter buying list', 2500)
            .then(() => true)
            .catch(() => false);
          if (!offered) continue;
          const sale = (session.world.sellOffers.get(mobile.serial) ?? []).filter((offer) => {
            const item = session.world.entities.get(offer.serial);
            return (
              item?.parent === backpackSerial() && item.graphic === board && !item.hue && offer.amount === item.amount
            );
          });
          if (!sale.length) continue;
          const gold = status().gold;
          await session.sell(
            mobile.serial,
            sale.map((offer) => ({ serial: offer.serial, amount: offer.amount }))
          );
          await session.refreshStatus();
          progress.sold += sale.reduce((sum, offer) => sum + offer.amount, 0);
          progress.earned += status().gold - gold;
          phase('sold', `Sold boards for ${status().gold - gold} gold`);
          break;
        }
      }
      if (!(await packs?.unload(woodSet, 1, room))) break;
    }
    const bank = serviceLocations(city, 'banker')[0];
    // Boards no carpenter bought would keep the pack at its limit; a player stores them in the bank.
    if (bank && (status().gold > 0 || heavy())) {
      phase('bank-travel', heavy() ? 'Storing unsold wood and banking the earnings' : 'Banking the earnings');
      await navigate(bank, 4);
      const banker = [...session.world.entities.values()].find(
        (mobile) => mobile.kind === 'mobile' && mobile.position && distance(position(), mobile.position) <= 11
      );
      if (banker && (await offersBank(session, banker.serial))) {
        const box = await openBankBox({ session, serial, position, terrain, navigate, check }, banker.serial);
        const stored = heavy() ? [board, log] : [];
        for (const item of carried().filter((entry) => entry.graphic === 0x0eed || stored.includes(entry.graphic))) {
          await session.moveItem(item.serial, box);
          await Bun.sleep(600);
        }
        await queryBankBalance({ session, serial, position, terrain, navigate, check, checkpoint }, banker.serial);
      }
    }
    if (!tool()) await buyHatchet();
    await packs?.acquire();
    progress.trips++;
  };

  const buyHatchet = async () => {
    const smith = serviceLocations(city, 'blacksmith')[0];
    if (!smith) throw new Error('No blacksmith landmark for a replacement hatchet');
    phase('resupply', 'Buying a replacement hatchet');
    await navigate(smith, 4);
    for (const mobile of [...session.world.entities.values()]) {
      if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
      const entry = await vendorMenu(mobile, 3006103);
      if (!entry) continue;
      await approachVendor({ session, terrain, position, navigate, check, serial }, mobile.serial);
      const before = session.world.received.get(0x74) ?? 0;
      session.world.buyOffers.clear();
      const current = await vendorMenu(mobile, 3006103);
      if (!current) continue;
      session.selectContext(mobile.serial, current.index);
      await session
        .waitFor(() => (session.world.received.get(0x74) ?? 0) > before, 'smith stock', 2500)
        .catch(() => {});
      const offer = [...session.world.buyOffers.values()]
        .flat()
        .find((item) => hatchets.has(session.world.entities.get(item.serial)?.graphic ?? 0) && item.price <= 60);
      if (!offer) continue;
      await chargedPurchase({ session, checkpoint, backpack: backpackSerial }, offer.price, () =>
        session.purchaseItem(mobile.serial, offer.serial, backpackSerial(), 1, 60)
      );
      return;
    }
    throw new Error('No vendor sold a replacement hatchet');
  };

  let stopped = 'Lumberjack run duration reached';
  try {
    phase('reconcile', 'Reading current inventory; previous transactions are never replayed');
    await session.refreshStatus();
    const pack = backpackSerial();
    const opened = session.world.received.get(0x3c) ?? 0;
    session.use(pack);
    await session.waitFor(() => (session.world.received.get(0x3c) ?? 0) > opened, 'backpack contents');
    const animals = {
      session,
      terrain,
      checkpoint,
      serial,
      position,
      status,
      check,
      phase,
      log: say,
      navigate: groundNavigate,
      persist,
      backpack: backpackSerial
    };
    mounts = createMountController(animals, city, 150);
    packs = createPackAnimal(animals, city);
    await mounts.acquire();
    await packs.acquire();
    await reachRegion({ session, position, navigate, phase }, woods);
    // Each lumberjack favours its own stand of trees in its woods.
    const offset = template.behavior.temperament?.miningAnchor;
    const anchor = offset ? { x: woods.x + Math.round(offset.dx / 2), y: woods.y + Math.round(offset.dy / 2) } : woods;
    // Every resident shares one event loop: turns start at least 250 ms apart and always yield,
    // so a turn that finds nothing to do can never starve the others.
    let turnAt = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        check();
        // A ghost is resurrected at the closest healer or ankh before anything else.
        if (isGhost({ session, serial })) {
          await resurrectGhost({ session, serial, terrain, position, navigate, check, phase, log: say });
          continue;
        }
        // Hurt woodsmen rest (natural regeneration) instead of stopping.
        if (status().hits < status().maxHits / 2) {
          await setback('health is below half');
          continue;
        }
        if (
          await scavenge({
            session,
            serial,
            terrain,
            position,
            status,
            navigate,
            check,
            phase,
            log: say,
            backpack: backpackSerial
          })
        )
          continue;
        if (!tool()) await buyHatchet();
        // Logs weigh 2 stones and boards 1: cut early, go to town only when even boards fill the pack.
        if (status().weight >= status().maxWeight * 0.7 && count(log)) await cutBoards();
        await packs.keepUp();
        // A full pack goes onto the pack animal while it has room.
        if (heavy() && (await packs.stow(woodSet))) continue;
        if (heavy()) {
          await town();
          // Back from town: a life break point (life.ts); errands are another town trip.
          const life = { session, terrain, template, checkpoint, city, position, check, phase, log: say, persist };
          if (await lifeTurn({ ...life, navigate, decisions: options.decisions, practise, errands: town })) continue;
          // A trip that could not lighten the pack must not spin straight back into town.
          if (heavy()) {
            phase('resting', 'The pack is still full after town; resting before trying again');
            const resumeAt = Math.min(deadline, Date.now() + 60_000);
            while (Date.now() < resumeAt) {
              check();
              await Bun.sleep(2000);
            }
          }
          continue;
        }
        const crowd = people();
        const tree = terrain
          .findStatics(treeStatics, distance(position(), anchor) > 60 ? { ...anchor, z: 0 } : position(), 40)
          .filter((candidate) => (depleted.get(`tree:${candidate.x},${candidate.y}`) ?? 0) <= Date.now())
          .sort((a, b) => {
            const cost = (point: { x: number; y: number }) =>
              distance(position(), point) +
              distance(point, anchor) * 0.3 +
              (crowd.some((mobile) => mobile.position && distance(mobile.position, point) <= 3) ? 30 : 0);
            return cost(a) - cost(b);
          })[0];
        // A quiet stand, or now and then by choice: practise a supporting skill before chopping on.
        if (!tree || Math.random() < 0.04) await practise();
        if (!tree) {
          phase('searching', 'Every nearby tree is chopped out; walking to my usual stand');
          await navigate(anchor, 3);
          continue;
        }
        phase('chop-travel', `Walking to a tree at ${tree.x},${tree.y}`);
        try {
          await navigate(tree, 1);
        } catch (error) {
          check();
          deplete(`tree:${tree.x},${tree.y}`);
          say(`Skipping unreachable tree ${tree.x},${tree.y}: ${error instanceof Error ? error.message : error}`);
          continue;
        }
        await mounts.dismountForGathering();
        phase('chopping', `Chopping the tree at ${tree.x},${tree.y}`);
        for (let swing = 0; swing < 20; swing++) {
          check();
          const axe = tool();
          if (!axe) break;
          const seen = new Set(session.world.journal);
          session.use(axe.serial);
          await session.waitFor(() => session.world.target !== null, 'hatchet cursor', 4000);
          session.target({ serial: 0, x: tree.x, y: tree.y, z: tree.z, graphic: tree.id });
          await Bun.sleep(2500);
          const replies = session.world.journal.filter((entry) => !seen.has(entry) && entry.cliloc !== undefined);
          const has = (clilocs: number[]) => replies.some((entry) => clilocs.includes(entry.cliloc ?? 0));
          progress.chops++;
          if (has(CHOPPED)) {
            progress.logs++;
            tally(session, 'chopped');
          }
          if (has(DEPLETED)) {
            deplete(`tree:${tree.x},${tree.y}`);
            break;
          }
          if (has([PACK_FULL])) {
            await cutBoards();
            break;
          }
          if (has([BROKE])) break;
          if (!replies.length)
            throw new Error('Chopping produced no interpretable feedback; stopping instead of repeating blindly');
          if (!has(CHOPPED) && !has([FAILED])) break;
        }
      } catch (error) {
        if (!isSetback(session, error, !!options.stopping?.(), deadline)) throw error;
        await setback(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    stopped = options.stopping?.()
      ? 'Lumberjack stopped by shutdown signal'
      : error instanceof Error
        ? error.message
        : String(error);
    phase('stopped', stopped);
    if (session.world.target && session.phase === 'ready') session.target(null);
  }
  return { ...progress, stopped };
}
