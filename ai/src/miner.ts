import { tally } from './activity';
import { openOwnBackpack } from './backpack';
import { Blocked, blockedReason } from './blocked';
import type { CharacterTemplate } from './config';
import { converse } from './conversation';
import { threatsNear } from './danger';
import type { DecisionCoordinator, DecisionPick } from './decisions';
import { reconcileExperience } from './experience';
import { lifeTurn } from './life';
import { serviceLocations } from './locations';
import { sellCarried } from './market';
import { createMinerPastimes } from './miner-pastimes';
import { chooseMiningActivity, minerPlan, rememberForges } from './miner-plan';
import { createMinerServices, ingot, tools } from './miner-services';
import { findMiningSite } from './miner-sites';
import { travelMinerHome } from './miner-travel';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator } from './navigation';
import { createPackAnimal } from './pack-animal';
import type { PlayerSession } from './protocol/session';
import { noticePeers } from './relationships';
import { resurrectGhost } from './resurrection';
import { isSetback } from './setback';
import type { Checkpoint } from './store';
import { type Point, Terrain } from './terrain';
import { reachRegion, workArea } from './work-areas';

const ore = new Set([0x19b7, 0x19b8, 0x19b9, 0x19ba]);
const oreIn = (items: { graphic: number; amount?: number }[]) =>
  items.reduce((sum, item) => sum + (ore.has(item.graphic) ? (item.amount ?? 1) : 0), 0);
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
  const { exhausted, newTrip, plan } = minerPlan(checkpoint, template, () => options.save(checkpoint));
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
  const ghost = () => [0x192, 0x193, 0x25f, 0x260].includes(session.world.entities.get(serial)?.graphic ?? 0);
  // A ghost walking to a healer passes the liveness check that stops every other action.
  let reviving = false;
  const revive = async () => {
    reviving = true;
    await resurrectGhost({ session, serial, terrain, position, navigate, check: () => {}, phase, log }).finally(() => {
      reviving = false;
    });
  };
  const check = () => {
    if (Date.now() >= deadline) throw new Error('Miner run duration reached');
    if (session.phase !== 'ready')
      throw new Error('Miner disconnected; reconnect and reconcile inventory before continuing');
    if (!reviving && ghost()) throw new Error('Miner is dead; resurrection behavior is pending');
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
    mounts = createMountController(animals, city, 150);
    packs = createPackAnimal(animals, city);
    await reachRegion({ session, position, navigate, phase }, home);
    await travelMinerHome({ session, position, navigate, phase, checkpoint, city, home, newTrip });
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
        await packs.keepUp();
        // A full pack goes onto the pack animal while it has room; mining goes on.
        if (status().weight >= miningLimit() && (await packs.stow(ore))) continue;
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
          // Spare iron goes to fellow residents at the Minoc market (market.ts); unsold iron is banked again.
          else if (
            (checkpoint.stock?.ingots ?? 0) >= 150 &&
            Math.random() < 0.3 &&
            (await withdrawIngots(backpack, 50, 100))
          ) {
            const market = { session, template, checkpoint, city, position, navigate, phase, backpack: () => backpack };
            await sellCarried({ ...market, decisions: options.decisions }, 'iron ingots', 5);
          }
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
          // A monster arriving mid-dig: leave the rock for town (danger.ts remembers the spot).
          if (threatsNear(session, position(), 8).length) {
            phase('avoiding', 'Monsters about; leaving the rock for town');
            await navigate(home, 5).catch(() => {});
            break;
          }
          const last = session.world.journal.at(-1);
          const oreBefore = oreIn(carried(backpack));
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
          if (oreIn(carried(backpack)) > oreBefore) tally(session, 'mined');
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
          `Mining batch made ${attempts - decisionAttemptsBefore} tool attempts; ${oreIn(carried(backpack))} ore units are now observed in the backpack.`
        );
        activeDecision = null;
        if (!carried(backpack).some((item) => ore.has(item.graphic))) exhausted.add(`tile:${site.x},${site.y}`);
      } catch (error) {
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
