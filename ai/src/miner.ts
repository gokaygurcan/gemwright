import { Blocked, blockedReason } from './blocked';
import type { CharacterTemplate } from './config';
import { converse } from './conversation';
import { type DecisionCoordinator, type DecisionPick, decisionGuard, decisionState } from './decisions';
import { reconcileExperience } from './experience';
import { lifeTurn } from './life';
import { serviceLocations } from './locations';
import { createMinerPastimes } from './miner-pastimes';
import { createMinerServices, forges, ingot, tools } from './miner-services';
import { findMiningSite } from './miner-sites';
import { travelMinerHome } from './miner-travel';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator } from './navigation';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import { noticePeers } from './relationships';
import { resurrectGhost } from './resurrection';
import { isSetback } from './setback';
import type { Checkpoint } from './store';
import { type Point, Terrain } from './terrain';
import { reachRegion, workArea } from './work-areas';

const ore = new Set([0x19b7, 0x19b8, 0x19b9, 0x19ba]);
const distance = (a: Point, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export async function runMiner(options: {
  session: PlayerSession;
  assets: string;
  template: CharacterTemplate;
  seconds: number;
  peers?: ReadonlyMap<number, string>;
  // Prefix for log lines when several residents share one process.
  label?: string;
  checkpoint: Checkpoint;
  decisions?: DecisionCoordinator;
  save: (checkpoint: Checkpoint) => void;
  stopping?: () => boolean;
}) {
  const { session, template } = options;
  // Each miner works its own district (work-areas.json), with that city's bank as home.
  const area = workArea('mining', options.label ?? template.id);
  const city = area.city.toLowerCase();
  if (session.world.map !== 1) throw new Error('The miner supports Trammel');
  const home = serviceLocations(city, 'banker')[0] ?? { x: area.x, y: area.y };
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
  checkpoint.landmarks ??= { forges: [] };
  // ServUO ore veins respawn 10-20 minutes after depletion (Mining.cs), so a depleted spot is
  // remembered across restarts for the longest respawn and then tried again.
  const depleted = new Map(
    (checkpoint.landmarks.depleted ?? []).filter((entry) => entry.until > Date.now()).map((e) => [e.key, e.until])
  );
  const exhausted = {
    has: (key: string) => (depleted.get(key) ?? 0) > Date.now(),
    add: (key: string) => {
      depleted.set(key, Date.now() + 20 * 60_000);
      if (checkpoint.landmarks)
        checkpoint.landmarks.depleted = [...depleted]
          .filter(([, until]) => until > Date.now())
          .slice(-300)
          .map(([k, until]) => ({ key: k, until }));
      options.save(checkpoint);
    }
  };
  const newTrip = () => {
    const roll = Math.random();
    const ceiling = Math.min(0.9, template.behavior.bankAtWeightRatio);
    return {
      smeltsSinceBank: 0,
      smeltsBeforeBank: roll < 0.2 ? 1 : roll < 0.75 ? 2 : roll < 0.95 ? 3 : 4,
      smeltAtWeightRatio: ceiling * (0.8 + Math.random() * 0.2),
      bankAtWeightRatio: ceiling * (0.9 + Math.random() * 0.1)
    };
  };
  checkpoint.mining ??= newTrip();
  const plan = () => {
    if (!checkpoint.mining) throw new Error('Miner trip plan is missing');
    return checkpoint.mining;
  };
  const unsmeltable = new Set<number>();
  let attempts = 0;
  let blockedSites = 0;
  const progress = { deposits: 0, trips: 0, purchases: 0, sold: 0, smelts: 0, ingotsProduced: 0, packRejected: false };
  const tag = options.label ? `miner:${options.label}` : 'miner';
  const log = (message: string) => console.error(`[${tag}] ${message}`);
  const phase = (value: string, note: string) => {
    checkpoint.goal = { kind: 'mining', phase: value };
    noticePeers(session, checkpoint, options.peers, template.behavior.sociability);
    void converse({ session, checkpoint, template, city: city, peers: options.peers, decisions: options.decisions });
    checkpoint.memories = [...checkpoint.memories.slice(-49), { at: new Date().toISOString(), text: note }];
    options.save(checkpoint);
    log(`${value}: ${note}`);
  };
  const check = () => {
    if (Date.now() >= deadline) throw new Error('Miner run duration reached');
    if (session.phase !== 'ready')
      throw new Error('Miner disconnected; reconnect and reconcile inventory before continuing');
    const self = session.world.entities.get(serial);
    if (self && [0x192, 0x193, 0x25f, 0x260].includes(self.graphic))
      throw new Error('Miner is dead; resurrection behavior is pending');
  };
  const rememberObservedForges = () => {
    for (const item of session.world.entities.values()) {
      const location = item.position;
      if (item.kind !== 'item' || !location || !forges.has(item.graphic) || distance(position(), location) > 18)
        continue;
      const remembered = checkpoint.landmarks?.forges ?? [];
      if (!remembered.some((forge) => distance(forge, location) === 0 && forge.z === location.z))
        checkpoint.landmarks = {
          ...checkpoint.landmarks,
          forges: [{ x: location.x, y: location.y, z: location.z }, ...remembered].slice(0, 16)
        };
    }
  };
  let mounts: ReturnType<typeof createMountController> | undefined;
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
  const openBackpack = async () => {
    const backpack = [...session.world.entities.values()].find(
      (item) => item.parent === session.world.serial && item.layer === Layer.Backpack
    );
    if (!backpack) throw new Error('No observed backpack');
    const before = session.world.received.get(0x3c) ?? 0;
    session.use(backpack.serial);
    await session.waitFor(() => (session.world.received.get(0x3c) ?? 0) > before, 'miner backpack contents');
    return backpack.serial;
  };
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
  const { smelt, bank, resupply, smithFromBank, withdrawIngots } = createMinerServices(servicesCtx);
  let backpackSerial = 0;
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
    const backpack = await openBackpack();
    backpackSerial = backpack;
    mounts = createMountController(
      {
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
      },
      city,
      150
    );
    await reachRegion({ session, position, navigate, phase }, home);
    await travelMinerHome({ session, position, navigate, phase, checkpoint, city, home, newTrip });
    if (distance(position(), home) < 180) await mounts.acquire();
    rememberObservedForges();
    if (plan().pending === 'smelt' && !smeltable(backpack).length) {
      if (carried(backpack).some((item) => item.graphic === ingot)) plan().smeltsSinceBank++;
      delete plan().pending;
    }
    phase(
      'trip-plan',
      `Smelt at ${(plan().smeltAtWeightRatio * 100).toFixed(0)}% weight; aim for ${plan().smeltsBeforeBank} smelting visits before banking`
    );
    // Every resident shares one event loop: turns start at least 250 ms apart and always yield,
    // so a turn that finds nothing to do can never starve the others.
    let turnAt = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        // Hurt miners rest (natural regeneration) instead of stopping.
        if (status().hits < status().maxHits / 2) {
          await setback('health is below half');
          continue;
        }
        check();
        await session.refreshStatus();
        const miningLimit = () => Math.min(status().maxWeight * plan().smeltAtWeightRatio, status().maxWeight - 30);
        const hasTool = () => carried(backpack).some((item) => tools.has(item.graphic));
        const needsSpace = () => progress.packRejected || carried(backpack).length >= 110;
        if (
          smeltable(backpack).length &&
          (status().weight >= miningLimit() || needsSpace() || !hasTool() || plan().pending === 'smelt')
        )
          await smelt(backpack);
        const hasIngots = carried(backpack).some((item) => item.graphic === ingot);
        const stranded = !smeltable(backpack).length && retainedOre(backpack).length > 0;
        if (
          (hasIngots || (stranded && (status().weight >= miningLimit() || needsSpace()))) &&
          (plan().smeltsSinceBank >= plan().smeltsBeforeBank ||
            plan().pending === 'bank' ||
            needsSpace() ||
            status().weight >= status().maxWeight * plan().bankAtWeightRatio ||
            !hasTool() ||
            status().weight >= miningLimit())
        ) {
          await bank(backpack);
          // A healthy banked iron stock: sometimes smith a batch for profit.
          if ((checkpoint.stock?.ingots ?? 0) >= 200 && Math.random() < 0.4) await smithFromBank(backpack);
          await resupplyOrPass(backpack);
          await mounts.acquire();
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
          const pick = await options.decisions.choose({
            kind: 'mining-activity',
            checkpoint,
            state: decisionState(session, template, checkpoint, {
              profession: 'miner',
              home: city,
              smeltsSinceBank: plan().smeltsSinceBank,
              tripSmeltGoal: plan().smeltsBeforeBank,
              weightCeiling: miningLimit(),
              oreStacks: smeltable(backpack).length,
              note: 'Ingots, gold and ore the forge refused are banked. Smelting reduces carried weight. Mine while capacity allows; smelt before travelling to bank. A town trip costs travel time.'
            }),
            observationRevision: session.world.revision,
            baseline: 'mine',
            stillCurrent: decisionGuard(session, options.stopping),
            candidates: [
              {
                id: 'mine',
                description: 'Continue mining with a carried tool and available backpack capacity.',
                valid: () => hasTool() && !needsSpace() && status().weight < miningLimit()
              },
              {
                id: 'smelt',
                description:
                  'Visit the nearby forge now and convert carried smeltable ore to lighter usable ingots, then reassess.',
                valid: () => smeltable(backpack).length > 0
              },
              {
                id: 'bank',
                description:
                  'Return to the city bank early with the carried ingots, then restock and start another trip.',
                valid: () => !smeltable(backpack).length && carried(backpack).some((item) => item.graphic === ingot)
              }
            ]
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
          // An unreachable site is skipped like a depleted one.
          if (!(error instanceof Blocked) || ++blockedSites > 8) throw error;
          exhausted.add(`tile:${site.x},${site.y}`);
          log(`Skipping unreachable site ${site.x},${site.y}: ${error.message}`);
          continue;
        }
        blockedSites = 0;
        await mounts.dismountForGathering();
        phase('mining', `Using the observed tool on ${site.floor ? 'cave floor' : 'rock'} at ${site.x},${site.y}`);
        for (let batch = 0; batch < 40; batch++) {
          check();
          await session.refreshStatus();
          if (status().weight >= miningLimit() || needsSpace()) break;
          const last = session.world.journal.at(-1);
          session.use(tool.serial);
          await session.waitFor(() => session.world.target !== null, 'mining tool cursor', 4000);
          const tile = site.graphic ? terrain.tile(site.graphic, true) : null;
          session.target({
            serial: 0,
            x: site.x,
            y: site.y,
            z: site.z + (tile && tile.flags & 0x200 ? tile.height : 0),
            graphic: site.graphic
          });
          attempts++;
          await Bun.sleep(2500);
          const since = last
            ? session.world.journal.slice(session.world.journal.indexOf(last) + 1)
            : session.world.journal;
          const feedback = since.filter((entry) => entry.cliloc !== undefined);
          log(`attempt ${attempts}: ${feedback.map((entry) => entry.cliloc).join('; ') || 'no localized feedback'}`);
          if (feedback.some((entry) => [503040, 503042, 500446, 501862, 501863, 500237].includes(entry.cliloc ?? 0))) {
            if (feedback.some((entry) => [503040, 503042].includes(entry.cliloc ?? 0)))
              exhausted.add(`${site.x >> 3},${site.y >> 3}`);
            else exhausted.add(`tile:${site.x},${site.y}`);
            break;
          }
          if (feedback.some((entry) => entry.cliloc === 1044038) || !session.world.entities.has(tool.serial)) break;
          if (!feedback.length)
            throw new Error('Mining produced no interpretable feedback; stopping instead of repeating blindly');
          if (feedback.some((entry) => entry.cliloc === 1010481)) {
            progress.packRejected = true;
            break;
          }
        }
        options.decisions?.finish(
          checkpoint,
          activeDecision,
          'completed',
          `Mining batch made ${attempts - decisionAttemptsBefore} tool attempts; ${carried(backpack)
            .filter((item) => ore.has(item.graphic))
            .reduce((sum, item) => sum + (item.amount ?? 1), 0)} ore units are now observed in the backpack.`
        );
        activeDecision = null;
        if (!carried(backpack).some((item) => ore.has(item.graphic))) exhausted.add(`tile:${site.x},${site.y}`);
      } catch (error) {
        if (/dead/i.test(String(error)) && session.phase === 'ready') {
          await resurrectGhost({ session, serial, terrain, position, navigate, check: () => {}, phase, log });
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
