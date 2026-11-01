import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { ingot } from '@gemwright/common/game/items';
import type { Entity } from '@gemwright/network/world';

import { DangerInterrupt } from './action-purpose';
import { openOwnBackpack } from './backpack';
import { Blocked, blockedReason } from './blocked';
import { shedDeathRobe, wearsDeathRobe } from './death-robe';
import type { DecisionPick } from './decisions';
import { actionScope, checkAction, yieldForInteraction } from './execution-session';
import { reconcileExperience } from './experience';
import { residentTurn } from './goal-turn';
import { leavesEarly, packFull, packItems, tidyPack, workGear } from './inventory';
import { lifeTurn } from './life';
import { logger } from './log';
import { watchStep } from './loop-watch';
import { minerBulkOrder } from './miner-bulk-orders';
import { digSite, ore, oreIn } from './miner-dig';
import { minerInventory } from './miner-inventory';
import { createMinerPastimes } from './miner-pastimes';
import { chooseMiningActivity, minerPlan, rememberForges } from './miner-plan';
import { createMinerServices, tools } from './miner-services';
import { findMiningSite } from './miner-sites';
import { minerDistrict, reachMinerHome } from './miner-travel';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator } from './navigation';
import { lighten } from './overload';
import { createPackAnimal } from './pack-animal';
import { observeResident } from './resident-observation';
import type { ResidentOptions } from './resident-options';
import { resurrectGhost } from './resurrection';
import { runnerCheck } from './runner-check';
import { SessionBreak } from './session-habits';
import { isSetback } from './setback';
import { asProfession } from './shared-turn';
import { answerDanger } from './skirmish';
import { type Point, Terrain } from './terrain';
import { TownChanged } from './towns';
import { reachRegion } from './work-areas';

const distance = (a: Point, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export async function runMiner(options: ResidentOptions) {
  const { session, template } = options;
  if (session.world.map !== 1) throw new Error('The miner supports Trammel');
  const { area, city, home, miningArea, anchor, banks, shops } = minerDistrict(options);
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
  const persist = () => {
    checkAction(session);
    options.save(checkpoint);
  };
  reconcileExperience(checkpoint);
  options.decisions?.reconcile(checkpoint);
  let activeDecision: DecisionPick | null = null;
  let decisionAttemptsBefore = 0;
  const { exhausted, newTrip, plan } = minerPlan(checkpoint, template, persist);
  const unsmeltable = new Set<number>();
  let attempts = 0;
  let blockedSites = 0;
  const progress = { deposits: 0, trips: 0, purchases: 0, sold: 0, smelts: 0, ingotsProduced: 0, packRejected: false };
  const tag = options.label ? `miner:${options.label}` : 'miner';
  const log = (message: string) => logger('miner').info(`[${tag}] ${message}`);
  const phase = (value: string, note: string) => {
    checkAction(session);
    watchStep(session, tag, value, note);
    checkpoint.goal = { kind: 'mining', phase: value, note: note };
    observeResident({
      session,
      checkpoint,
      template,
      city: city,
      peers: options.peers,
      decisions: options.decisions,
      persist
    });
    checkpoint.memories = [...checkpoint.memories.slice(-49), { at: new Date().toISOString(), text: note }];
    persist();
    log(`${value}: ${note}`);
  };
  const ghost = () => GHOST_BODIES.has(session.world.entities.get(serial)?.graphic ?? 0);
  // Until the reconcile below knows whether this miner is dead, checks must not treat death as a
  // run-ending condition: the first status read itself runs the check, and a dead miner that just
  // logged back in would stop before ever reaching its resurrection (the relogin ghost loop).
  let reviving = true;
  const revive = async () => {
    reviving = true;
    await resurrectGhost({ session, serial, terrain, position, navigate, check: () => {}, phase, log }).finally(() => {
      reviving = false;
    });
  };
  const check = runnerCheck({
    session,
    label: 'Miner',
    deadline,
    stopping: options.stopping,
    dead: ghost,
    reviving: () => reviving
  });
  session.setActivityCheck?.(check);
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
  const { carried, smeltable, retainedOre } = minerInventory(session, unsmeltable);
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
    persist
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
    persist,
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
    else reviving = false;
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
      persist,
      backpack: () => backpack
    };
    // A riding horse waits for savings: a newcomer's first gold goes on its work (mounts.ts).
    mounts = createMountController(animals, city, 1000);
    packs = createPackAnimal(animals, city);
    // The way home can be long: hurt on it, it gets clear and goes on, instead of giving up the run.
    await reachMinerHome({ session, position, navigate, phase, checkpoint, city, home, newTrip, log }, async () => {
      await answerDanger(professional, undefined);
      if (ghost()) await revive();
    });
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
    const activePacks = packs;
    const activeMounts = mounts;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        await actionScope(session, 'work', 'miner turn', async () => {
          const consumed = await residentTurn(professional, {
            trade: 'miner',
            keep: (item: Entity) => workGear.has(item.graphic),
            life: life(bank, options.decisions),
            settle: async () => {
              await smelt(backpack);
              await bank(backpack);
            },
            order: () => minerBulkOrder(professional, withdrawIngots),
            prepare: () => resupplyOrPass(backpack),
            recover: async () => {
              if (ghost()) await revive();
              else await setback('Recovering health before mining');
            },
            optional: () => lifeTurn(life(bank, options.decisions))
          });
          // The turn guard runs even when the plan consumed the turn (bounded recovery and goal
          // deadlines depend on it).
          check();
          if (consumed) return;
          await session.refreshStatus();
          const miningLimit = () =>
            Math.min(status().maxWeight * Math.max(0.78, plan().smeltAtWeightRatio), status().maxWeight - 30);
          const hasTool = () => carried(backpack).some((item) => tools.has(item.graphic));
          const needsSpace = () => progress.packRejected || packItems(session, backpack).length >= 110;
          await activePacks.keepUp();
          // A full pack goes onto the pack animal while it has room; mining goes on.
          if (status().weight >= miningLimit() && (await activePacks.stow(ore))) return;
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
            if (needsSpace() || packFull(session, backpack, 0.85)) activePacks.fullLoad();
            await bank(backpack);
            if (!(await minerBulkOrder(professional, withdrawIngots, true))) {
              // A healthy banked iron stock: sometimes smith a batch for profit.
              if ((checkpoint.stock?.ingots ?? 0) >= 200 && Math.random() < 0.4) await smithFromBank(backpack);
            }
            await resupplyOrPass(backpack);
            await activeMounts.acquire().then(() => packs?.acquire());
            if (await lifeTurn(life(bank, options.decisions))) return;
          }
          if (status().weight >= miningLimit() || needsSpace()) {
            // Never quit on a full pack: bank, else pass the time.
            log('Backpack capacity leaves no safe room to mine; banking and reassessing');
            await bank(backpack);
            if (status().weight >= miningLimit() || needsSpace())
              log(
                `Pack still full; chose ${(await pastime(backpack, ['learn', 'train', 'wander'])) ?? 'a short rest'}`
              );
            return;
          }
          const tool = [...session.world.entities.values()].find(
            (item) => item.parent === backpack && tools.has(item.graphic)
          );
          if (!tool) {
            await resupplyOrPass(backpack);
            return;
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
            if (!pick) return;
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
              return;
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
              return;
            }
          }
          if (await pickUp(backpack)) return;
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
            return;
          }
          const { site, approachRange } = found;
          phase('mine-travel', `Travelling to ${site.floor ? 'cave floor' : 'rock'} at ${site.x},${site.y}`);
          try {
            await navigate(site.floor ? site : { x: site.x, y: site.y }, approachRange);
          } catch (error) {
            if (!(error instanceof Blocked) || ++blockedSites > 8) throw error;
            exhausted.add(`tile:${site.x},${site.y}`);
            log(`Skipping unreachable site ${site.x},${site.y}: ${error.message}`);
            return;
          }
          blockedSites = 0;
          await activeMounts.dismountForGathering();
          phase('mining', `Using the observed tool on ${site.floor ? 'cave floor' : 'rock'} at ${site.x},${site.y}`);
          attempts += await digSite(
            { session, terrain, check, status, position, phase, log, navigate, home, exhausted, progress },
            {
              backpack,
              carried,
              tool: tool.serial,
              site,
              full: () => status().weight >= miningLimit() || needsSpace()
            },
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
        });
      } catch (error) {
        if (await yieldForInteraction(session, error)) continue;
        if (error instanceof DangerInterrupt) {
          try {
            await answerDanger(professional, home);
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
    if (error instanceof SessionBreak || error instanceof TownChanged) throw error;
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
