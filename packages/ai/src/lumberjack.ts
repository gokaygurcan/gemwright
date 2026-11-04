import { PLAIN_HUMAN_BODIES } from '@gemwright/common/game/bodies';
import { board, logPile } from '@gemwright/common/game/items';
import { Layer } from '@gemwright/network/layers';
import type { Entity } from '@gemwright/network/world';

import { DangerInterrupt } from './action-purpose';
import { openOwnBackpack } from './backpack';
import { Blocked } from './blocked';
import { threatsNear, unsafeCheck } from './danger';
import { actionScope, checkAction, yieldForInteraction } from './execution-session';
import { residentTurn } from './goal-turn';
import { leavesEarly, packFull, packItems, packSummary } from './inventory';
import { lifeTurn } from './life';
import { pickLocation, townAt } from './locations';
import { logger } from './log';
import { watchStep } from './loop-watch';
import { chopTree } from './lumber-chop';
import { hatchets } from './lumber-shop';
import { createLumberTown } from './lumber-town';
import { treeStatics } from './lumber-trees';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator, distance } from './navigation';
import { createPackAnimal } from './pack-animal';
import { failResidentGoal } from './resident-goal';
import { observeResident } from './resident-observation';
import type { ResidentOptions } from './resident-options';
import { isGhost } from './resurrection';
import { runnerCheck } from './runner-check';
import { sellingTurn } from './selling';
import { SessionBreak } from './session-habits';
import { isSetback, passSetback } from './setback';
import { asProfession } from './shared-turn';
import { trainSupportingSkill } from './skill-training';
import { answerDanger } from './skirmish';
import { learnedPlaceCost } from './strategy-learning';
import { Terrain } from './terrain';
import { TownChanged, townFor } from './towns';
import { reachRegion, workArea } from './work-areas';

const log = logPile;
const woodSet = new Set([board]);
// Trees regrow 20-30 minutes after depletion (Lumberjacking.cs MinRespawn/MaxRespawn).
const REGROW = 30 * 60_000;
// A resident with no axe and no gold for one does not ask again until this passes (runLumberjack).
const noToolUntil = new WeakMap<import('@gemwright/network/session').PlayerSession, number>();
// Boards sell for 2 gold, logs for 1. Cutting is skill-free, 1:1, and halves their weight.

export async function runLumberjack(options: ResidentOptions) {
  const { session, template } = options;
  // Each lumberjack works its own woods (work-areas.json) and sells in that city.
  const woods = workArea(
    'woods',
    options.label ?? template.id,
    townFor(session, 'lumberjack'),
    undefined,
    session.world.position ?? undefined
  );
  const city = woods.city.toLowerCase();
  const serial = session.world.serial;
  if (serial === null || session.world.map !== 1) throw new Error('The lumberjack supports Trammel Britain');
  const terrain = Terrain.shared(options.assets, 1);
  const deadline = Date.now() + options.seconds * 1000;
  const checkpoint = structuredClone(options.checkpoint);
  checkpoint.landmarks ??= { forges: [] };
  const progress = { chops: 0, logs: 0, boards: 0, sold: 0, earned: 0, trips: 0 };
  const tag = options.label ? `lumberjack:${options.label}` : 'lumberjack';
  const say = (message: string) => logger('lumberjack').info(`[${tag}] ${message}`);
  const persist = () => {
    checkAction(session);
    options.save(checkpoint);
  };
  const phase = (value: string, note: string) => {
    checkAction(session);
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
  const check = runnerCheck({ session, label: 'Lumberjack', deadline, stopping: options.stopping });
  session.setActivityCheck?.(check);
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
  const { cutBoards, town, buyHatchet } = createLumberTown({
    session,
    serial,
    terrain,
    city,
    checkpoint,
    progress,
    position,
    status,
    navigate,
    check,
    phase,
    say,
    carried,
    count,
    tool,
    heavy,
    practise,
    backpackSerial,
    packs: () => packs
  });

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
    log: say,
    persist,
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
    // A riding horse waits for savings: a newcomer's first gold goes on its work (mounts.ts).
    mounts = createMountController(animals, city, 1000);
    packs = createPackAnimal(animals, city);
    // Hurt on the way (fetching animals, walking to the woods): clear of danger, then the loop
    // carries on, instead of the run ending and starting over into the same trouble.
    try {
      await mounts.acquire();
      await packs.acquire();
      await reachRegion({ session, position, navigate, phase }, woods);
    } catch (error) {
      // No way to the woods yet (Blocked): the work loop and its setbacks deal with it.
      if (error instanceof Blocked) say(`Could not reach the woods yet: ${error.message}`);
      else if (!(error instanceof DangerInterrupt)) throw error;
      else await answerDanger(professional, pickLocation(townAt(position(), city), 'banker'));
    }
    // Each lumberjack favours its own stand of trees in its woods.
    const offset = template.behavior.temperament?.miningAnchor;
    const anchor = offset ? { x: woods.x + Math.round(offset.dx / 2), y: woods.y + Math.round(offset.dy / 2) } : woods;
    // Empty turns must yield to the other residents.
    let turnAt = 0;
    const activePacks = packs;
    const activeMounts = mounts;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        await actionScope(session, 'work', 'lumberjack turn', async () => {
          check();
          if (
            await residentTurn(professional, {
              trade: 'lumberjack',
              keep: (item: Entity) => hatchets.has(item.graphic),
              settle: town,
              prepare: buyHatchet,
              optional: () => lifeTurn({ ...professional, decisions: options.decisions, errands: town })
            })
          )
            return;
          if (!tool() && Date.now() >= (noToolUntil.get(session) ?? 0)) {
            try {
              await buyHatchet();
            } catch (error) {
              // No hatchet and no gold for one: earning comes first (sell what it carries); with
              // nothing to sell either, the question is not asked again for a while so the turns
              // go to income work instead of a purchase that cannot happen.
              if (!(error instanceof Blocked) || error.reason !== 'insufficient-funds') throw error;
              const coins = status().gold ?? 0;
              await sellingTurn(professional, true);
              if ((status().gold ?? 0) <= coins) {
                say('No hatchet and no gold for one; this work waits for income');
                failResidentGoal(session, 'No hatchet and no gold for one');
                noToolUntil.set(session, Date.now() + 10 * 60_000);
                return;
              }
            }
          }
          // Logs weigh 2 stones and boards 1: cut early, go to town only when even boards fill the pack.
          if ((status().weight >= status().maxWeight * 0.9 || packFull(session, backpackSerial())) && count(log))
            await cutBoards();
          await activePacks.keepUp();
          // A full pack goes onto the pack animal while it has room.
          if (heavy() && (await activePacks.stow(woodSet))) {
            full = false;
            return;
          }
          if (heavy()) {
            // A pack truly full (not a choice to stop early) counts toward a pack animal (pack-animal.ts).
            if (packFull(session, backpackSerial())) activePacks.fullLoad();
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
              return;
            // A trip that could not lighten the pack must not spin straight back into town.
            if (heavy()) {
              phase('resting', 'The pack is still full after town; resting before trying again');
              const resumeAt = Math.min(deadline, Date.now() + 60_000);
              while (Date.now() < resumeAt) {
                check();
                await Bun.sleep(2000);
              }
            }
            return;
          }
          const crowd = people();
          // Never work, or practise, within reach of monsters (danger.ts): leave for town instead.
          if (distance(position(), anchor) < 80 && threatsNear(session, position(), 8).length) {
            phase('avoiding', 'Monsters about; leaving the woods for town');
            await answerDanger(professional, pickLocation(townAt(position(), city), 'banker'));
            return;
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
            return;
          }
          phase('chop-travel', `Walking to a tree at ${tree.x},${tree.y}`);
          try {
            await navigate(tree, 1);
          } catch (error) {
            check();
            deplete(`tree:${tree.x},${tree.y}`);
            say(`Skipping unreachable tree ${tree.x},${tree.y}: ${error instanceof Error ? error.message : error}`);
            return;
          }
          await activeMounts.dismountForGathering();
          phase('chopping', `Chopping the tree at ${tree.x},${tree.y}`);
          // ServUO harvests only with the axe in hand (HarvestTarget: 500487, "The axe must be equipped").
          // A one-handed hatchet cannot be worn alongside a two-handed axe already in hand (the shard
          // refuses that equip), so whatever the other hand holds is stowed first.
          const axe = tool();
          if (axe && axe.parent !== serial) {
            for (const held of [...session.world.entities.values()].filter(
              (item) => item.parent === serial && (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded)
            ))
              await session.moveItem(held.serial, backpackSerial()).catch(() => {});
            await session
              .equipItem(axe.serial, terrain.tile(axe.graphic, true).layer || Layer.TwoHanded)
              .catch((error) => say(`Could not equip the hatchet: ${error instanceof Error ? error.message : error}`));
          }
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
        });
      } catch (error) {
        if (await yieldForInteraction(session, error)) continue;
        if (error instanceof DangerInterrupt) {
          await answerDanger(professional, pickLocation(townAt(position(), city), 'banker'));
          continue;
        }
        if (!isSetback(session, error, !!options.stopping?.(), deadline)) throw error;
        await setback(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    if (error instanceof SessionBreak || error instanceof TownChanged) throw error;
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
