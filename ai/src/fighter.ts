import { tally } from './activity';
import { Blocked, type BlockedReason, blockedReason } from './blocked';
import { atGround, groundOf, nearAnyGround, nextGround, patrolPoints, returnHome, travelToGround } from './cemeteries';
import type { CharacterTemplate } from './config';
import { converse } from './conversation';
import type { DecisionCoordinator, DecisionPick } from './decisions';
import type { RunRecord } from './dungeon-context';
import { dungeonTurn } from './dungeon-turn';
import { reconcileExperience } from './experience';
import { createFighterCombat } from './fighter-combat';
import {
  bandage,
  Died,
  type FighterContext,
  ghosts,
  gold,
  healPotion,
  homeOf,
  huntable,
  observedThreat,
  Retreat
} from './fighter-context';
import { fighterDungeon, fighterLife } from './fighter-dungeon';
import { fightOpponent } from './fighter-encounter';
import { createFighterEquipment } from './fighter-equipment';
import { chooseOpponent } from './fighter-hunt';
import { createCorpseLooter } from './fighter-loot';
import { createFighterRecovery } from './fighter-recovery';
import { createFighterTown } from './fighter-town';
import { fieldUpkeep, planTownTrip } from './fighter-trip';
import { lifeTurn } from './life';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator, distance } from './navigation';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import { noticePeers } from './relationships';
import { scavenge } from './scavenge';
import { isSetback, passSetback } from './setback';
import { trainSupportingSkill } from './skill-training';
import type { Checkpoint } from './store';
import { Terrain } from './terrain';

export async function runFighter(options: {
  session: PlayerSession;
  assets: string;
  template: CharacterTemplate;
  seconds: number;
  overland?: boolean;
  peers?: ReadonlyMap<number, string>;
  // Prefix for log lines when several residents share one process.
  label?: string;
  checkpoint: Checkpoint;
  decisions?: DecisionCoordinator;
  save: (checkpoint: Checkpoint) => void;
  recordRun?: (record: RunRecord) => void;
  stopping?: () => boolean;
}) {
  const { session, template } = options;
  const serial = session.world.serial;
  // Fighters live anywhere in Trammel.
  if (serial === null || session.world.map !== 1) throw new Error('Fighter requires a Trammel character');
  const home = homeOf(template.creation.city, () => session.world.position ?? { x: 0, y: 0 });
  const checkpoint = structuredClone(options.checkpoint);
  reconcileExperience(checkpoint);
  options.decisions?.reconcile(checkpoint);
  let activeDecision: DecisionPick | null = null;
  let returnDecision: DecisionPick | null = null;
  checkpoint.hunting ??= { loot: [], killsSinceBank: 0, pending: 'hunt' };
  const trip = checkpoint.hunting;
  if (checkpoint.decisions?.history.at(-1)?.execution.status === 'failed' && trip.killsSinceBank > 0)
    trip.pending = 'return';
  const terrain = Terrain.shared(options.assets, 1);
  const deadline = Date.now() + options.seconds * 1000;
  const tag = options.label ? `fighter:${options.label}` : 'fighter';
  const log = (message: string) => console.error(`[${tag}] ${message}`);
  const persist = () => options.save(checkpoint);
  const phase = (value: string, text: string) => {
    checkpoint.goal = { kind: 'hunting', phase: value };
    noticePeers(session, checkpoint, options.peers, template.behavior.sociability);
    void converse({
      session,
      checkpoint,
      template,
      city: home.city,
      peers: options.peers,
      decisions: options.decisions
    });
    checkpoint.memories = [...checkpoint.memories.slice(-49), { at: new Date().toISOString(), text }];
    persist();
    log(`${value}: ${text}`);
  };
  const position = () => {
    if (!session.world.position) throw new Error('Position unknown');
    return session.world.position;
  };
  const status = () => {
    if (!session.world.status) throw new Error('Status unknown');
    return session.world.status;
  };
  const dead = () => ghosts.has(session.world.entities.get(serial)?.graphic ?? 0);
  const state: FighterContext['state'] = {
    recovering: false,
    recoveringCorpse: false,
    inCombat: false,
    abandonedBandageCursor: false,
    fightingSerial: null
  };
  const check = () => {
    if (options.stopping?.() || Date.now() >= deadline) throw new Error('Fighter run duration reached or interrupted');
    if (session.phase !== 'ready') throw new Error('Fighter disconnected; reconcile before continuing');
    if (state.abandonedBandageCursor && session.world.target) {
      session.target(null);
      state.abandonedBandageCursor = false;
    }
    if (dead() && !state.recovering) throw new Died('Character died');
    if (
      state.recoveringCorpse &&
      (status().hits < status().maxHits * 0.8 ||
        nearby().some(
          (mobile) =>
            mobile.position &&
            observedThreat(mobile, session.world.combatant) &&
            distance(position(), mobile.position) < 8
        ))
    )
      throw new Retreat('Corpse approach became unsafe');
    if (state.inCombat) {
      const assessment = combatAssessment();
      if (assessment.emergency) {
        stats.burstEscapes++;
        phase(
          'emergency-escape',
          `${assessment.reason} Largest recent hit ${assessment.largestHit}; incoming ${assessment.damagePerSecond.toFixed(1)} HP/s; remaining ${status().hits}/${status().maxHits}.`
        );
        throw new Retreat(assessment.reason);
      }
    }
  };
  let mounts: ReturnType<typeof createMountController> | undefined;
  let travelling = false;
  let checkingRoad = false;
  let roadSteps = 0;
  const groundNavigate = createNavigator({
    session,
    terrain,
    check,
    phase,
    log,
    onStep: async () => {
      if (!options.overland || !travelling || checkingRoad || ++roadSteps % 24 !== 0) return;
      checkingRoad = true;
      try {
        const choice = await chooseOpponent(ctx, { unreachable, stopping: options.stopping });
        if (choice.kind === 'fight') {
          phase('road-encounter', `Engaging observed undead ${choice.opponent.serial} while travelling`);
          await defeat(choice.opponent);
          await fieldUpkeep(ctx, heal);
        }
      } finally {
        checkingRoad = false;
      }
    }
  });
  const navigate = mountedNavigator(
    groundNavigate,
    () => mounts,
    () => !state.inCombat && !state.recovering && !dead(),
    position
  );
  const escapeNavigate = createNavigator({ session, terrain, check, phase, log, runClose: true, avoidRest: true });
  let backpack = [...session.world.entities.values()].find(
    (item) => item.parent === serial && item.layer === Layer.Backpack
  )?.serial;
  if (!backpack) throw new Error('No observed backpack');
  const contents = (container = backpack) =>
    [...session.world.entities.values()].filter((item) => item.parent === container);
  const count = (graphic: number) =>
    contents()
      .filter((item) => item.graphic === graphic)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const open = async (container: number) => {
    const before = session.world.received.get(0x3c) ?? 0;
    session.use(container);
    await session.waitFor(() => (session.world.received.get(0x3c) ?? 0) > before, 'container contents', 4000);
  };
  const stats: FighterContext['stats'] = {
    kills: 0,
    looted: 0,
    sold: 0,
    bankedGold: 0,
    bankedItems: 0,
    retreats: 0,
    resurrections: 0,
    tacticalBreaks: 0,
    reengagements: 0,
    burstEscapes: 0,
    completedBandages: 0,
    failedBandages: 0,
    recoveredItems: 0,
    abandonedCorpses: 0,
    replacementWeapons: 0
  };
  let patrolIndex = template.behavior.temperament?.patrolOffset ?? 0;
  const unreachable = new Set<number>();
  let blockedStreak = 0;
  let idlePatrols = 0;
  const nearby = () =>
    [...session.world.entities.values()].filter(
      (item) =>
        item.kind === 'mobile' && item.serial !== serial && item.position && distance(position(), item.position) <= 16
    );
  const refreshBackpack = async () => {
    const observed = [...session.world.entities.values()].find(
      (item) => item.parent === serial && item.layer === Layer.Backpack
    );
    if (!observed) throw new Error('No observed backpack after recovery');
    backpack = observed.serial;
    await open(backpack);
  };
  const ctx: FighterContext = {
    session,
    home,
    template,
    terrain,
    checkpoint,
    trip,
    serial,
    deadline,
    backpack: () => {
      if (!backpack) throw new Error('Backpack is not observed');
      return backpack;
    },
    refreshBackpack,
    position,
    status,
    dead,
    contents,
    count,
    nearby,
    open,
    navigate,
    escapeNavigate,
    check,
    phase,
    log,
    persist,
    state,
    stats
  };
  mounts = createMountController(
    {
      ...ctx,
      navigate: groundNavigate,
      safeToRecover: (point) =>
        !nearby().some(
          (e) => e.position && observedThreat(e, session.world.combatant) && distance(point, e.position) < 10
        )
    },
    home.city
  );
  const combat = createFighterCombat(ctx);
  const { combatAssessment, drinkPotion, heal } = combat;
  const { restock, sellLoot, bank, rest, contextAction, openBank } = createFighterTown(ctx, heal);
  const { equip, prepareEquipment, dress } = createFighterEquipment(ctx, { contextAction, openBank, restock });
  const { recover } = createFighterRecovery(ctx, { rest, equip, prepareEquipment, decisions: options.decisions });
  const setback = (reason: string) =>
    passSetback(
      {
        session,
        check,
        phase,
        log,
        deadline,
        archetype: template.archetype,
        items: () => [...session.world.childrenOf(serial), ...session.world.childrenOf(ctx.backpack())],
        recover: rest
      },
      reason
    );
  const lootCorpse = createCorpseLooter(ctx, dress);
  const defeat = async (opponent: Parameters<typeof fightOpponent>[2]) => {
    await fightOpponent(ctx, combat, opponent, options.decisions, options.stopping);
    state.inCombat = false;
    session.setWarMode(false);
    stats.kills++;
    idlePatrols = 0;
    blockedStreak = 0;
    trip.killsSinceBank++;
    persist();
    const death = session.world.deaths.get(opponent.serial);
    if (death) tally(session, 'kills');
    phase('looting', 'Collecting valuables from the defeated undead');
    await Bun.sleep(600);
    if (death) await lootCorpse(death.corpse);
    delete trip.encounter;
    persist();
  };
  const initialize = async () => {
    await session.refreshStatus();
    await session.refreshSkills();
    await recover();
    await refreshBackpack();
    if (trip.encounter) {
      const interrupted = trip.encounter.opponent;
      trip.pending = 'return';
      delete trip.encounter;
      phase(
        'reconciling-encounter',
        `Encounter with ${interrupted} was interrupted; returning to town with observed inventory instead of replaying combat or looting`
      );
    }
    if (trip.pending === 'return') {
      session.setWarMode(false);
      await returnHome(ctx);
      if (nearAnyGround(position()) || nearby().some((mobile) => observedThreat(mobile, session.world.combatant)))
        await escapeNavigate(home.town, 4);
    }
    await prepareEquipment();
    if (trip.pending !== 'return') {
      await restock();
      await rest();
      await mounts.acquire();
    }
  };
  let initialized = false;
  let outcome = 'completed';
  let blocked: BlockedReason | undefined;
  try {
    // Every resident shares one event loop: turns start at least 250 ms apart and always yield,
    // so a turn that finds nothing to do can never starve the others.
    let turnAt = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        if (!initialized) {
          await initialize();
          initialized = true;
        }
        check();
        if (await scavenge(ctx)) continue;
        if (trip.pending !== 'return' && atGround(ctx)) {
          await fieldUpkeep(ctx, heal);
          const need = await planTownTrip(ctx, options.decisions);
          if (need) {
            trip.pending = 'return';
            persist();
            log(`Returning to town: ${need}`);
          }
        }
        if (trip.pending === 'return') {
          session.setWarMode(false);
          await returnHome(ctx);
          if (nearAnyGround(position()) || nearby().some((mobile) => observedThreat(mobile, session.world.combatant)))
            await escapeNavigate(home.town, 4);
          await sellLoot();
          await bank();
          options.decisions?.finish(
            checkpoint,
            returnDecision,
            'completed',
            'Returned to town and reconciled loot sales and bank deposits.'
          );
          returnDecision = null;
          await prepareEquipment();
          await rest();
          await mounts.acquire();
        }
        if ((trip.reconsiderAt ?? 0) > Date.now()) {
          phase('experience-rest', 'Waiting safely in town before reconsidering a recently dangerous encounter');
          const until = Math.min(deadline, trip.reconsiderAt ?? 0, Date.now() + 30_000);
          while (Date.now() < until) {
            check();
            await Bun.sleep(250);
          }
          continue;
        }
        delete trip.reconsiderAt;
        if (count(healPotion) < 1 && count(bandage) < 1)
          throw new Error('No healing supplies available; stopping before combat');
        // Leaving town for the hunt (or resuming a run): a dungeon instead, now and then.
        // A dungeon run resumes; leaving town for the hunt is a life break point (life.ts).
        const below = fighterDungeon(ctx, { defeat, heal, dress, unreachable, record: options.recordRun });
        if (await dungeonTurn(below, false)) continue;
        const town = { sellLoot, bank, restock };
        if (!atGround(ctx) && (await lifeTurn(fighterLife(ctx, below, town, options.decisions)))) continue;
        if (!atGround(ctx)) {
          travelling = true;
          try {
            await travelToGround(ctx, options.overland);
          } finally {
            travelling = false;
          }
        }
        phase('choosing-opponent', 'Looking for an opponent I can take on');
        const choice = await chooseOpponent(ctx, {
          unreachable,
          decisions: options.decisions,
          stopping: options.stopping
        });
        // Opponents ruled out by recent losses are ignored, not waited out in town; a player hunts
        // what it can handle and lets the dangerous ones be.
        if (choice.kind === 'avoid')
          phase('avoiding-recent-danger', 'Ignoring undead that recently beat this character; looking for others');
        if (choice.kind === 'return') {
          trip.pending = 'return';
          returnDecision = choice.pick;
          persist();
          continue;
        }
        activeDecision = choice.kind === 'avoid' ? null : choice.pick;
        const opponent = choice.kind === 'fight' ? choice.opponent : undefined;
        if (!opponent) {
          // An empty cemetery is crowded or picked clean: move on.
          if (++idlePatrols > 6 + (template.behavior.temperament?.patrolOffset ?? 0)) {
            idlePatrols = 0;
            trip.ground = options.overland
              ? ({ Britain: 'Yew', Yew: 'Britain', Cove: 'Vesper', Vesper: 'Cove' }[trip.ground ?? 'Britain'] ??
                'Britain')
              : nextGround(ctx);
            persist();
            phase('changing-ground', `Nothing to hunt here lately; moving on to ${trip.ground}`);
            continue;
          }
          const patrol = patrolPoints(groundOf(trip));
          // Each resident walks its own direction around the cemetery.
          const step = template.behavior.temperament?.patrolReverse ? patrol.length - 1 : 1;
          patrolIndex += step;
          const next = patrol[patrolIndex % patrol.length];
          if (!next) throw new Error('No cemetery patrol landmark');
          phase('patrolling', `Looking through the ${groundOf(trip).name} cemetery near ${next.x},${next.y}`);
          await navigate(next, 2);
          await Bun.sleep(1800);
          // A quiet sweep leaves time to practise a supporting skill.
          if (idlePatrols % 3 === 0 && !nearby().some((m) => huntable(m, new Set())))
            await trainSupportingSkill({
              session,
              check,
              phase,
              log,
              archetype: template.archetype,
              until: Math.min(deadline, Date.now() + (60 + Math.random() * 120) * 1000),
              items: () => [...session.world.childrenOf(serial), ...session.world.childrenOf(ctx.backpack())],
              interrupt: () =>
                nearby().some((m) => huntable(m, new Set()) && !!m.position && distance(position(), m.position) < 14)
            });
          options.decisions?.finish(
            checkpoint,
            activeDecision,
            'completed',
            `Patrolled to ${position().x},${position().y}; reobserving opponents.`
          );
          activeDecision = null;
          continue;
        }
        await defeat(opponent);
        options.decisions?.finish(
          checkpoint,
          activeDecision,
          'completed',
          `Observed selected opponent ${opponent.serial} die and reconciled its corpse. Health ${status().hits}/${status().maxHits}; gold ${count(gold)}.`
        );
        activeDecision = null;
      } catch (error) {
        options.decisions?.finish(
          checkpoint,
          activeDecision,
          options.stopping?.() ? 'interrupted' : 'failed',
          error instanceof Error ? error.message : 'Fighter action failed'
        );
        activeDecision = null;
        state.inCombat = false;
        if (error instanceof Died || dead()) {
          await recover();
          continue;
        }
        if (error instanceof Blocked && session.phase === 'ready' && !options.stopping?.()) {
          if (++blockedStreak > 5) {
            blockedStreak = 0;
            await setback(`Repeatedly blocked: ${error.message}`);
            continue;
          }
          if (state.fightingSerial !== null) unreachable.add(state.fightingSerial);
          state.fightingSerial = null;
          delete trip.encounter;
          persist();
          session.setWarMode(false);
          phase('blocked', `${error.message}; choosing another course`);
          continue;
        }
        if (error instanceof Retreat) {
          stats.retreats++;
          trip.pending = 'return';
          phase('retreating', error.message);
          session.setWarMode(false);
          drinkPotion();
          continue;
        }
        if (!isSetback(session, error, !!options.stopping?.(), deadline)) throw error;
        await setback(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error);
    blocked = blockedReason(error);
    options.decisions?.finish(checkpoint, activeDecision, options.stopping?.() ? 'interrupted' : 'failed', outcome);
    options.decisions?.finish(checkpoint, returnDecision, options.stopping?.() ? 'interrupted' : 'failed', outcome);
    phase('stopped', outcome);
  } finally {
    if (session.phase === 'ready') {
      if (session.world.target) session.target(null);
      session.setWarMode(false);
    }
  }
  return {
    outcome,
    blocked,
    ...stats,
    trip
  };
}
