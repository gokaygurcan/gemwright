import { GHOST_BODIES } from '@gemwright/common/bodies';
import { skillId } from '@gemwright/common/skills';

import { DangerInterrupt } from './action-purpose';
import { openOwnBackpack } from './backpack';
import { Blocked, blockedReason } from './blocked';
import { bulkOrderTurn } from './bulk-orders';
import { escapeDanger, interruptForDanger } from './danger-response';
import { shedDeathRobe, wearsDeathRobe } from './death-robe';
import type { DecisionPick } from './decisions';
import { reconcileExperience } from './experience';
import { leavesEarly, packFull, packItems, tidyPack, workGear } from './inventory';
import { lifeTurn } from './life';
import { pickLocation, serviceLocations } from './locations';
import { info } from './log';
import { checkLoop, watchStep } from './loop-watch';
import { sellCarried } from './market';
import { blacksmithing } from './miner-crafting';
import { digSite, ore, oreIn } from './miner-dig';
import { createMinerPastimes } from './miner-pastimes';
import { chooseMiningActivity, minerPlan, rememberForges } from './miner-plan';
import { createMinerServices, ingot, tools } from './miner-services';
import { findMiningSite } from './miner-sites';
import { travelMinerHome } from './miner-travel';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator } from './navigation';
import { lighten } from './overload';
import { createPackAnimal } from './pack-animal';
import type { Entity } from './protocol/world';
import { observeResident } from './resident-observation';
import type { ResidentOptions } from './resident-options';
import { resurrectGhost } from './resurrection';
import { isSetback } from './setback';
import { asProfession, sideTurn, upkeepTurn } from './shared-turn';
import { type Point, Terrain } from './terrain';
import { reachRegion, workArea } from './work-areas';

const distance = (a: Point, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export async function runMiner(options: ResidentOptions) {
  const { session, template } = options;
  // Each miner works its own district (work-areas.json), with that city's bank as home.
  const area = workArea('mining', options.label ?? template.id, template.creation.city);
  const city = area.city.toLowerCase();
  if (session.world.map !== 1) throw new Error('The miner supports Trammel');
  const home = pickLocation(city, 'banker') ?? { x: area.x, y: area.y };
  const miningArea = { x: area.x, y: area.y, z: 0 };
  // Each miner favours its own part of the district.
  const offset = template.behavior.temperament?.miningAnchor;
  const anchor = miningArea && offset ? { x: miningArea.x + offset.dx, y: miningArea.y + offset.dy } : miningArea;
  const banks = serviceLocations(city, 'banker');
  const shops = serviceLocations(area.toolCity ?? city, 'mining-tools');
  const serial = session.world.serial;
  if (serial === null) throw new Error('Miner character is unknown');
  const position = () => {
    if (!session.world.position) throw new Error('Miner position is unknown');
    return session.world.position;
  };
  const status = () => {
    if (!session.world.status) throw new Error('Miner status is unknown');
    return session.world.status;
  };
  const terrain = Terrain.shared(options.assets, 1);
  const deadline = Date.now() + options.seconds * 1000;
  const blocked = new Set<string>();
  const checkpoint = structuredClone(options.checkpoint);
  reconcileExperience(checkpoint);
  options.decisions?.reconcile(checkpoint);
  let activeDecision: DecisionPick | null = null;
  let decisionAttemptsBefore = 0;
  const { exhausted, newTrip, plan } = minerPlan(checkpoint, template, () => options.save(checkpoint));
  const unsmeltable = new Set<number>();
  let attempts = 0;
  let blockedSites = 0;
  const progress = { deposits: 0, trips: 0, purchases: 0, sold: 0, smelts: 0, ingotsProduced: 0, packRejected: false };
  const tag = options.label ? `miner:${options.label}` : 'miner';
  const log = (message: string) => info(`[${tag}] ${message}`);
  const phase = (value: string, note: string) => {
    watchStep(session, tag, value, note);
    checkpoint.goal = { kind: 'mining', phase: value, note: note };
    observeResident({
      session,
      checkpoint,
      template,
      city: city,
      peers: options.peers,
      decisions: options.decisions,
      persist: () => options.save(checkpoint)
    });
    checkpoint.memories = [...checkpoint.memories.slice(-49), { at: new Date().toISOString(), text: note }];
    options.save(checkpoint);
    log(`${value}: ${note}`);
  };
  const ghost = () => GHOST_BODIES.has(session.world.entities.get(serial)?.graphic ?? 0);
  // A ghost walking to a healer passes the liveness check that stops every other action.
  let reviving = false;
  const revive = async () => {
    reviving = true;
    await resurrectGhost({ session, serial, terrain, position, navigate, check: () => {}, phase, log }).finally(() => {
      reviving = false;
    });
  };
  const check = () => {
    checkLoop(session);
    if (Date.now() >= deadline) throw new Error('Miner run duration reached');
    if (session.phase !== 'ready')
      throw new Error('Miner disconnected; reconnect and reconcile inventory before continuing');
    if (!reviving && ghost()) throw new Error('Miner is dead; resurrection behavior is pending');
    if (!reviving) interruptForDanger(session);
  };
  const rememberObservedForges = () => rememberForges(session, checkpoint, position());

  let mounts: ReturnType<typeof createMountController> | undefined;
  let packs: ReturnType<typeof createPackAnimal> | undefined;
  const groundNavigate = createNavigator({
    session,
    terrain,
    check,
    phase,
    log,
    blocked,
    onStep: rememberObservedForges
  });
  const navigate = mountedNavigator(groundNavigate, () => mounts, undefined, position);
  const openBackpack = () => openOwnBackpack(session);
  const carried = (backpack: number) => [...session.world.entities.values()].filter((item) => item.parent === backpack);
  const smeltable = (backpack: number) =>
    carried(backpack).filter(
      (item) =>
        ore.has(item.graphic) && !unsmeltable.has(item.serial) && !(item.graphic === 0x19b7 && (item.amount ?? 1) < 2)
    );
  const retainedOre = (backpack: number) => {
    const usable = new Set(smeltable(backpack).map((item) => item.serial));
    return carried(backpack).filter((item) => ore.has(item.graphic) && !usable.has(item.serial));
  };
  const servicesCtx = {
    session,
    serial,
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
    progress,
    persist: () => options.save(checkpoint)
  };
  const { smelt: smeltCarried, bank, resupply, smithFromBank, withdrawIngots } = createMinerServices(servicesCtx);
  // Smelts what is carried, then what the pack animal carries, a load at a time.
  const room = () => status().maxWeight - 30 - status().weight;
  const smelt = async (backpack: number) => {
    await smeltCarried(backpack);
    while (await packs?.unload(ore, 12, room)) await smeltCarried(backpack);
  };
  let backpackSerial = 0;
  const professional = asProfession({
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
    log,
    persist: () => options.save(checkpoint),
    backpack: () => backpackSerial
  });
  const { pastime, setback, resupplyOrPass, life, pickUp } = createMinerPastimes(servicesCtx, {
    smithFromBank,
    withdrawIngots,
    resupply,
    deadline,
    template,
    backpack: () => backpackSerial
  });
  try {
    phase('reconcile', 'Reading current inventory and status; previous transactions are never replayed');
    await session.refreshStatus();
    if (options.decisions) await session.refreshSkills();
    // A ghost cannot open its pack ("I am dead and cannot do that"): resurrection comes first.
    if (ghost()) await revive();
    const backpack = await openBackpack();
    backpackSerial = backpack;
    // Too heavy to walk anywhere (the bank, the forge): lighten first.
    await session.refreshStatus();
    await lighten(session, backpack, (item) => workGear.has(item.graphic), log);
    await tidyPack(session, backpack, log, terrain);
    if (wearsDeathRobe(session)) await shedDeathRobe(session, terrain, carried(backpack));
    const animals = {
      session,
      terrain,
      checkpoint,
      serial,
      position,
      status,
      check,
      phase,
      log,
      navigate: groundNavigate,
      persist: () => options.save(checkpoint),
      backpack: () => backpack
    };
    // A riding horse waits for savings: a newcomer's first gold goes on its work (mounts.ts).
    mounts = createMountController(animals, city, 1000);
    packs = createPackAnimal(animals, city);
    // The way home can be long: hurt on it, it gets clear and goes on, instead of giving up the run.
    for (let tries = 0; tries < 5; tries++) {
      try {
        await reachRegion({ session, position, navigate, phase }, home);
        await travelMinerHome({ session, position, navigate, phase, checkpoint, city, home, newTrip });
        break;
      } catch (error) {
        // No way home yet: the work loop and its setbacks take it from here.
        if (error instanceof Blocked) {
          log(`Could not reach home yet: ${error.message}`);
          break;
        }
        if (!(error instanceof DangerInterrupt)) throw error;
        await escapeDanger({ session, check, phase, navigate }, undefined);
        if (ghost()) await revive();
      }
    }
    if (distance(position(), home) < 180) await mounts.acquire().then(() => packs?.acquire());
    rememberObservedForges();
    if (plan().pending === 'smelt' && !smeltable(backpack).length) {
      if (carried(backpack).some((item) => item.graphic === ingot)) plan().smeltsSinceBank++;
      delete plan().pending;
    }
    phase(
      'trip-plan',
      `Smelt at ${(plan().smeltAtWeightRatio * 100).toFixed(0)}% weight; aim for ${plan().smeltsBeforeBank} smelting visits before banking`
    );
    // Empty turns must yield to the other residents.
    let turnAt = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        // Upkeep, selling, banking, rest, escorts, players' shops and a side trade after a loop,
        // as for every trade (shared-turn.ts).
        const shared = {
          trade: 'miner',
          keep: (item: Entity) => workGear.has(item.graphic),
          life: life(bank, options.decisions),
          needed: (checkpoint.sideTrade?.until ?? 0) > Date.now()
        };
        if ((await upkeepTurn(professional, shared)) || (await sideTurn(professional, shared))) continue;
        check();
        await session.refreshStatus();
        const miningLimit = () =>
          Math.min(status().maxWeight * Math.max(0.78, plan().smeltAtWeightRatio), status().maxWeight - 30);
        const hasTool = () => carried(backpack).some((item) => tools.has(item.graphic));
        const needsSpace = () => progress.packRejected || packItems(session, backpack).length >= 110;
        await packs.keepUp();
        // A full pack goes onto the pack animal while it has room; mining goes on.
        if (status().weight >= miningLimit() && (await packs.stow(ore))) continue;
        let smelted = false;
        if (
          smeltable(backpack).length &&
          (status().weight >= miningLimit() || needsSpace() || !hasTool() || plan().pending === 'smelt')
        ) {
          // Far from any forge (visiting another town): smelting waits for the way home.
          await smelt(backpack).catch(async (error) => {
            if (!(error instanceof Error) || !error.message.startsWith('No reachable forge')) throw error;
            phase('mine-travel', 'No forge near here; heading back to the mines');
            await reachRegion({ session, position, navigate, phase }, home);
          });
          smelted = true;
        }
        const hasIngots = carried(backpack).some((item) => item.graphic === ingot);
        const stranded = !smeltable(backpack).length && retainedOre(backpack).length > 0;
        // Smelt to lighten the load before banking.
        if (
          (hasIngots || (stranded && (status().weight >= miningLimit() || needsSpace()))) &&
          (plan().pending === 'bank' ||
            needsSpace() ||
            packFull(session, backpack, 0.85) ||
            !hasTool() ||
            (stranded && status().weight >= miningLimit()) ||
            (smelted && leavesEarly(session)))
        ) {
          if (needsSpace() || packFull(session, backpack, 0.85)) packs.fullLoad();
          await bank(backpack);
          // A healthy banked iron stock: sometimes smith a batch for profit.
          if ((checkpoint.stock?.ingots ?? 0) >= 200 && Math.random() < 0.4) await smithFromBank(backpack);
          // Spare iron goes to fellow residents at the Minoc market (market.ts); unsold iron is banked again.
          else if (
            (checkpoint.stock?.ingots ?? 0) >= 150 &&
            Math.random() < 0.3 &&
            (await withdrawIngots(backpack, 50, 100))
          ) {
            const market = { session, template, checkpoint, city, position, navigate, phase, backpack: () => backpack };
            await sellCarried({ ...market, decisions: options.decisions }, 'iron ingots', 5);
          }
          // Now and then a smith takes a bulk order at the smithy, iron from the bank (bulk-orders.ts).
          const smith = session.world.skills.get(skillId('Blacksmith'))?.base ?? 0;
          if (smith >= 50 && Math.random() < 0.3)
            await bulkOrderTurn(
              { ...professional, refill: (pack, least) => withdrawIngots(pack, least, least * 2) },
              blacksmithing,
              smith
            ).catch(() => false);
          await resupplyOrPass(backpack);
          await mounts.acquire().then(() => packs?.acquire());
          if (await lifeTurn(life(bank, options.decisions))) continue;
        }
        if (status().weight >= miningLimit() || needsSpace()) {
          // Never quit on a full pack: bank, else pass the time.
          log('Backpack capacity leaves no safe room to mine; banking and reassessing');
          await bank(backpack);
          if (status().weight >= miningLimit() || needsSpace())
            log(`Pack still full; chose ${(await pastime(backpack, ['learn', 'train', 'wander'])) ?? 'a short rest'}`);
          continue;
        }
        const tool = [...session.world.entities.values()].find(
          (item) => item.parent === backpack && tools.has(item.graphic)
        );
        if (!tool) {
          await resupplyOrPass(backpack);
          continue;
        }
        if (options.decisions) {
          const pick = await chooseMiningActivity(options.decisions, session, template, checkpoint, {
            city,
            plan: plan(),
            ceiling: miningLimit(),
            ore: smeltable(backpack).length,
            canMine: hasTool() && !needsSpace() && status().weight < miningLimit(),
            canBank: !smeltable(backpack).length && carried(backpack).some((item) => item.graphic === ingot),
            stopping: options.stopping
          });
          check();
          if (!pick) continue;
          activeDecision = pick;
          decisionAttemptsBefore = attempts;
          if (pick.id === 'smelt') {
            const before = progress.ingotsProduced;
            await smelt(backpack);
            options.decisions.finish(
              checkpoint,
              pick,
              'completed',
              `Confirmed ${progress.ingotsProduced - before} ingots produced by this smelting visit.`
            );
            activeDecision = null;
            continue;
          }
          if (pick.id === 'bank') {
            const before = progress.deposits;
            await bank(backpack);
            options.decisions.finish(
              checkpoint,
              pick,
              'completed',
              `Confirmed ${progress.deposits - before} ingots deposited.`
            );
            activeDecision = null;
            await resupplyOrPass(backpack);
            continue;
          }
        }
        if (await pickUp(backpack)) continue;
        if (miningArea && distance(position(), miningArea) > 90) {
          phase('mine-travel', `Returning to the ${area.city} mining district`);
          // The district centre can sit inside the mountain; arriving anywhere nearby is enough.
          await navigate(miningArea, 25);
        }
        const found = await findMiningSite({
          session,
          terrain,
          serial,
          position,
          check,
          exhausted,
          blocked,
          miningArea,
          anchor
        });
        if (!found) {
          // Shared veins respawn in 10-20 minutes (ServUO Mining); pass the time.
          log(`Nearby veins are worked out; chose ${(await pastime(backpack)) ?? 'a short rest'}`);
          continue;
        }
        const { site, approachRange } = found;
        phase('mine-travel', `Travelling to ${site.floor ? 'cave floor' : 'rock'} at ${site.x},${site.y}`);
        try {
          await navigate(site.floor ? site : { x: site.x, y: site.y }, approachRange);
        } catch (error) {
          if (!(error instanceof Blocked) || ++blockedSites > 8) throw error;
          exhausted.add(`tile:${site.x},${site.y}`);
          log(`Skipping unreachable site ${site.x},${site.y}: ${error.message}`);
          continue;
        }
        blockedSites = 0;
        await mounts.dismountForGathering();
        phase('mining', `Using the observed tool on ${site.floor ? 'cave floor' : 'rock'} at ${site.x},${site.y}`);
        attempts += await digSite(
          { session, terrain, check, status, position, phase, log, navigate, home, exhausted, progress },
          { backpack, carried, tool: tool.serial, site, full: () => status().weight >= miningLimit() || needsSpace() },
          attempts
        );
        options.decisions?.finish(
          checkpoint,
          activeDecision,
          'completed',
          `Mining batch made ${attempts - decisionAttemptsBefore} tool attempts; ${oreIn(carried(backpack))} ore units are now observed in the backpack.`
        );
        activeDecision = null;
        if (!carried(backpack).some((item) => ore.has(item.graphic))) exhausted.add(`tile:${site.x},${site.y}`);
      } catch (error) {
        if (error instanceof DangerInterrupt) {
          try {
            await escapeDanger({ session, check, phase, navigate }, home);
          } catch (error) {
            if (ghost() && session.phase === 'ready') await revive();
            else throw error;
          }
          continue;
        }
        if (/dead/i.test(String(error)) && session.phase === 'ready') {
          await revive();
          continue;
        }
        if (!isSetback(session, error, false, deadline)) throw error;
        await setback(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    const reason = options.stopping?.()
      ? 'Miner stopped by shutdown signal'
      : error instanceof Error
        ? error.message
        : 'Unknown miner failure';
    options.decisions?.finish(checkpoint, activeDecision, options.stopping?.() ? 'interrupted' : 'failed', reason);
    phase('stopped', reason);
    if (session.world.target && session.phase === 'ready') session.target(null);
    return { attempts, ...progress, stopped: reason, blocked: blockedReason(error) };
  }
  return { attempts, ...progress, stopped: 'Miner run duration reached' };
}
