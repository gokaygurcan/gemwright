import { PLAIN_HUMAN_BODIES } from '@gemwright/common/bodies';
import { gold } from '@gemwright/common/items';

import { DangerInterrupt } from './action-purpose';
import { openOwnBackpack } from './backpack';
import { bankSurplus, offersBank, openBankBox, queryBankBalance } from './bank-gold';
import { threatsNear, unsafeCheck } from './danger';
import { escapeDanger, interruptForDanger } from './danger-response';
import { replaceDeathRobe, shedDeathRobe, wearsDeathRobe } from './death-robe';
import { leavesEarly, packFull, packItems, packSummary, tidyPack } from './inventory';
import { lifeTurn } from './life';
import { pickLocation, townAt } from './locations';
import { info } from './log';
import { checkLoop, watchStep } from './loop-watch';
import { chopTree } from './lumber-chop';
import { buyHatchetFrom, hatchets, vendorMenu } from './lumber-shop';
import { treeStatics } from './lumber-trees';
import { sellAtMarket } from './market';
import { approachVendor } from './mobile-approach';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator, distance } from './navigation';
import { createPackAnimal } from './pack-animal';
import { personalTurn } from './personal-turn';
import { Layer } from './protocol/layers';
import { observeResident } from './resident-observation';
import type { ResidentOptions } from './resident-options';
import { isGhost, resurrectGhost } from './resurrection';
import { scavenge } from './scavenge';
import { sellingTurn } from './selling';
import { isSetback, passSetback } from './setback';
import { loopSideTrade } from './side-trade';
import { trainSupportingSkill } from './skill-training';
import { learnedPlaceCost } from './strategy-learning';
import { Terrain } from './terrain';
import { reachRegion, workArea } from './work-areas';

const log = 0x1bdd;
const board = 0x1bd7;
const woodSet = new Set([board]);
// Trees regrow 20-30 minutes after depletion (Lumberjacking.cs MinRespawn/MaxRespawn).
const REGROW = 30 * 60_000;
// Boards sell for 2 gold, logs for 1. Cutting is skill-free, 1:1, and halves their weight.

export async function runLumberjack(options: ResidentOptions) {
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
  const say = (message: string) => info(`[${tag}] ${message}`);
  const persist = () => options.save(checkpoint);
  const phase = (value: string, note: string) => {
    watchStep(session, tag, value, note);
    checkpoint.goal = { kind: 'lumberjacking', phase: value, note: note };
    observeResident({
      session,
      checkpoint,
      template,
      city,
      peers: options.peers,
      decisions: options.decisions,
      persist
    });
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
    checkLoop(session);
    if (options.stopping?.() || Date.now() >= deadline) throw new Error('Lumberjack run duration reached');
    if (session.phase !== 'ready') throw new Error('Lumberjack disconnected; reconnect before continuing');
    interruptForDanger(session);
  };
  const setback = (reason: string) =>
    passSetback(
      {
        session,
        check,
        phase,
        checkpoint,
        log: say,
        deadline,
        archetype: template.archetype,
        items: () => [...session.world.childrenOf(serial), ...carried()]
      },
      reason
    );
  // A craftsman supporting skill: Arms Lore on the hatchet, Carpentry with carried boards, and so on.
  // `only` narrows it to one skill (Carpentry from a full load of boards).
  const practise = async (only?: string) => {
    const until = Math.min(deadline, Date.now() + (2 + Math.random() * 3) * 60_000);
    const archetype =
      only && template.archetype ? { ...template.archetype, supportingSkills: [only] } : template.archetype;
    await trainSupportingSkill({
      session,
      check,
      phase,
      log: say,
      until,
      archetype,
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
  // A load is done when the pack is full (inventory.ts) or the resident chose to stop early.
  let full = false;
  const heavy = () => full || packFull(session, backpackSerial());
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
      (mobile) => mobile.kind === 'mobile' && mobile.serial !== serial && PLAIN_HUMAN_BODIES.has(mobile.graphic)
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

  // Town trip: sell boards to the carpenter, bank the gold, replace a broken hatchet.
  const town = async () => {
    await cutBoards();
    await replaceDeathRobe({
      ...{ session, serial, terrain, position, navigate, check, phase, log: say, checkpoint, status, city },
      carried: (pack: number) => session.world.childrenOf(pack),
      backpack: backpackSerial
    });
    // Occasionally craft furniture before selling the boards.
    if (count(board) >= 50 && Math.random() < 0.25) await practise('Carpentry');
    // Boards go to fellow residents at the bank first (market.ts); the carpenter takes the rest.
    const market = { session, template, checkpoint, city, position, navigate, phase, backpack: backpackSerial };
    await sellAtMarket(
      { ...market, decisions: options.decisions },
      'boards',
      count(board),
      count(board) >= 100 ? 8 : 4
    );
    const carpenter = pickLocation(city, 'carpenter');
    // Pack animal boards sell a load at a time.
    const room = () => status().maxWeight - 20 - status().weight;
    for (let load = 0; load < 20; load++) {
      if (carpenter && count(board) > 0) {
        phase('selling', `Taking ${count(board)} boards to the carpenter`);
        await navigate(carpenter, 4);
        for (const mobile of [...session.world.entities.values()]) {
          if (mobile.kind !== 'mobile' || !mobile.position || distance(position(), mobile.position) > 10) continue;
          const entry = await vendorMenu(session, mobile, 3006104);
          if (!entry) continue;
          await approachVendor({ session, terrain, position, navigate, check, serial }, mobile.serial);
          session.world.sellOffers.delete(mobile.serial);
          const current = await vendorMenu(session, mobile, 3006104);
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
    const bank = pickLocation(city, 'banker');
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
        for (const item of carried().filter((entry) => entry.graphic === gold || stored.includes(entry.graphic))) {
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

  const buyHatchet = () =>
    buyHatchetFrom({
      session,
      terrain,
      position,
      navigate,
      check,
      serial,
      phase,
      checkpoint,
      city,
      backpack: backpackSerial
    });

  let stopped = 'Lumberjack run duration reached';
  try {
    phase('reconcile', 'Reading current inventory; previous transactions are never replayed');
    await session.refreshStatus();
    // A ghost cannot open its pack; the work loop resurrects it first and the pack is observed after.
    if (!isGhost({ session, serial })) await openOwnBackpack(session);
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
    // Empty turns must yield to the other residents.
    let turnAt = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        check();
        await tidyPack(session, backpackSerial(), say, terrain);
        if (
          await loopSideTrade(
            {
              session,
              serial,
              terrain,
              template,
              checkpoint,
              city,
              deadline,
              position,
              status,
              navigate,
              check,
              phase,
              log: say,
              persist,
              backpack: backpackSerial
            },
            'lumberjack'
          )
        )
          continue;
        await bankSurplus(
          { session, serial, position, terrain, navigate, check, checkpoint, phase, backpack: backpackSerial },
          city
        );
        if (
          await sellingTurn({
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
            carried: (pack: number) => session.world.childrenOf(pack),
            backpack: backpackSerial
          })
        )
          continue;
        if (
          await personalTurn({
            session,
            terrain,
            template,
            checkpoint,
            city,
            position,
            check,
            phase,
            log: say,
            persist,
            navigate,
            practise: () => practise()
          })
        )
          continue;
        if (isGhost({ session, serial })) {
          await resurrectGhost({ session, serial, terrain, position, navigate, check, phase, log: say });
          continue;
        }
        if (wearsDeathRobe(session)) await shedDeathRobe(session, terrain, session.world.childrenOf(backpackSerial()));
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
        if ((status().weight >= status().maxWeight * 0.9 || packFull(session, backpackSerial())) && count(log))
          await cutBoards();
        await packs.keepUp();
        // A full pack goes onto the pack animal while it has room.
        if (heavy() && (await packs.stow(woodSet))) {
          full = false;
          continue;
        }
        if (heavy()) {
          await town();
          full = false;
          // Back from town: a life break point (life.ts); errands are another town trip.
          const life = { session, terrain, template, checkpoint, city, position, check, phase, log: say, persist };
          if (
            await lifeTurn({
              ...life,
              navigate,
              decisions: options.decisions,
              practise: () => practise(),
              errands: town
            })
          )
            continue;
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
        // Never work, or practise, within reach of monsters (danger.ts): leave for town instead.
        if (distance(position(), anchor) < 80 && threatsNear(session, position(), 8).length) {
          phase('avoiding', 'Monsters about; leaving the woods for town');
          await escapeDanger({ session, check, phase, navigate }, pickLocation(townAt(position(), city), 'banker'));
          continue;
        }
        const risky = unsafeCheck(session);
        const tree = terrain
          .findStatics(treeStatics, distance(position(), anchor) > 60 ? { ...anchor, z: 0 } : position(), 40)
          .filter((candidate) => (depleted.get(`tree:${candidate.x},${candidate.y}`) ?? 0) <= Date.now())
          .filter((candidate) => !risky(candidate))
          .sort((a, b) => {
            const cost = (point: { x: number; y: number }) =>
              distance(position(), point) +
              distance(point, anchor) * 0.3 +
              learnedPlaceCost(checkpoint, session.world.map ?? 1, point) +
              (crowd.some((mobile) => mobile.position && distance(mobile.position, point) <= 3) ? 30 : 0);
            return cost(a) - cost(b);
          })[0];
        // A quiet stand, or now and then by choice: practise a supporting skill before chopping on.
        if (tree && Math.random() < 0.04) await practise();
        if (!tree) {
          // Chopped out or unsafe: town business, then a safe practice there.
          phase('searching', 'No safe tree to chop nearby; going to town');
          await town();
          await practise();
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
        // ServUO harvests only with the axe in hand (HarvestTarget: 500487, "The axe must be equipped").
        const axe = tool();
        if (axe && axe.parent !== serial)
          await session
            .equipItem(axe.serial, terrain.tile(axe.graphic, true).layer || Layer.TwoHanded)
            .catch((error) => say(`Could not equip the hatchet: ${error instanceof Error ? error.message : error}`));
        const chop = await chopTree(
          {
            session,
            check,
            say,
            tool,
            cutBoards,
            full: () => packFull(session, backpackSerial()),
            logs: () => count(log),
            noted: () => progress.chops++,
            describe: () =>
              `${packItems(session, backpackSerial()).length} items: ${packSummary(session, backpackSerial())}`
          },
          tree
        );
        progress.logs += chop.gathered;
        if (chop.depleted || !chop.answered) deplete(`tree:${tree.x},${tree.y}`);
        if (chop.full || (chop.gathered && leavesEarly(session))) full = true;
      } catch (error) {
        if (error instanceof DangerInterrupt) {
          await escapeDanger({ session, check, phase, navigate }, pickLocation(townAt(position(), city), 'banker'));
          continue;
        }
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
