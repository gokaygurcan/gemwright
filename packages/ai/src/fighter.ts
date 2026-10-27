import { gold } from '@gemwright/common/items';

import { recentlyHurt, takingUrgentAction } from './action-purpose';
import { tally } from './activity';
import { recoverWithAid } from './aid-recovery';
import { knownBankGold } from './bank-gold';
import { Blocked, type BlockedReason, blockedReason } from './blocked';
import {
  atGround,
  fightBack,
  groundOf,
  hurtOnTheWay,
  nextGround,
  patrolPoints,
  retreatedFrom,
  travelToGround
} from './cemeteries';
import type { DecisionPick } from './decisions';
import { dungeonTurn } from './dungeon-turn';
import { escortOpportunity } from './escort';
import { reconcileExperience } from './experience';
import { createFighterCombat } from './fighter-combat';
import {
  Ambushed,
  Died,
  type FighterContext,
  ghosts,
  homeOf,
  huntable,
  newFighterStats,
  observedThreat,
  Retreat
} from './fighter-context';
import { fighterDungeon, fighterLife } from './fighter-dungeon';
import { fightOpponent } from './fighter-encounter';
import { createFighterEquipment } from './fighter-equipment';
import { createFighterErrands } from './fighter-errands';
import { chooseOpponent } from './fighter-hunt';
import { createCorpseLooter } from './fighter-loot';
import { createFighterRecovery } from './fighter-recovery';
import { registerFighterSocial } from './fighter-social';
import { createFighterTown } from './fighter-town';
import { fieldUpkeep, planTownTrip } from './fighter-trip';
import { lifeTurn } from './life';
import { info } from './log';
import { checkLoop, watchStep } from './loop-watch';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator, distance } from './navigation';
import { personalTurn } from './personal-turn';
import { playerPartyTurn } from './player-party';
import { Layer } from './protocol/layers';
import { observeResident } from './resident-observation';
import type { ResidentOptions } from './resident-options';
import { scavenge } from './scavenge';
import { isSetback, passSetback } from './setback';
import { housekeeping } from './shared-turn';
import { trainSupportingSkill } from './skill-training';
import { Terrain } from './terrain';

export async function runFighter(options: ResidentOptions) {
  const { session, template } = options;
  const serial = session.world.serial;
  if (serial === null || session.world.map !== 1) throw new Error('Fighter needs Trammel');
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
  const log = (message: string) => info(`[${tag}] ${message}`);
  const persist = () => options.save(checkpoint);
  const phase = (value: string, text: string) => {
    watchStep(session, tag, value, text);
    checkpoint.goal = { kind: 'hunting', phase: value, note: text };
    observeResident({
      session,
      checkpoint,
      template,
      city: home.city,
      peers: options.peers,
      decisions: options.decisions,
      persist
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
  // Built below; check runs after.
  let self: FighterContext | undefined;
  const check = () => {
    checkLoop(session);
    if (options.stopping?.() || Date.now() >= deadline) throw new Error('Fighter run duration reached or interrupted');
    if (session.phase !== 'ready') throw new Error('Fighter disconnected; reconcile before continuing');
    if (state.abandonedBandageCursor && session.world.target) {
      session.target(null);
      state.abandonedBandageCursor = false;
    }
    if (dead() && !state.recovering) throw new Died('Character died');
    if (!state.recovering && !takingUrgentAction(session) && recentlyHurt(session) && self) hurtOnTheWay(self);
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
    // On the road it steers around monsters; at the hunting ground they are the work.
    wary: () => travelling,
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
  const escapeNavigate = createNavigator({
    session,
    terrain,
    check,
    phase,
    log,
    runClose: true,
    avoidRest: true,
    purpose: 'escape'
  });
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
  const stats = newFighterStats();
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
  self = ctx;
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
        checkpoint,
        recover: rest
      },
      reason
    );
  const lootCorpse = createCorpseLooter(ctx, dress);
  const errands = createFighterErrands(ctx, {
    sellLoot,
    bank,
    prepareEquipment,
    rest,
    acquireMount: () => mounts.acquire()
  });
  const defeat = async (opponent: Parameters<typeof fightOpponent>[2]) => {
    const defeated = await fightOpponent(ctx, combat, opponent, options.decisions, options.stopping);
    state.inCombat = false;
    session.setWarMode(false);
    stats.kills++;
    idlePatrols = 0;
    blockedStreak = 0;
    trip.killsSinceBank++;
    persist();
    const death = session.world.deaths.get(defeated.serial);
    if (death) tally(session, 'kills');
    phase('looting', 'Collecting valuables from the defeated undead');
    await Bun.sleep(600);
    if (death) await lootCorpse(death.corpse);
    delete trip.encounter;
    persist();
  };
  registerFighterSocial(ctx, defeat, heal);
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
    if (trip.pending === 'return') await errands.leaveGround();
    await errands.tidyAndSell();
    if (trip.pending !== 'return') {
      await restock();
      await rest();
      await mounts.acquire();
    }
  };
  let ambusher: Ambushed['attacker'] | undefined;
  let initialized = false;
  let outcome = 'completed';
  let blocked: BlockedReason | undefined;
  try {
    // Empty turns must yield to the other residents.
    let turnAt = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        // Housekeeping each turn, before a setup that may fail (shared-turn.ts).
        if (!dead() && (await housekeeping(errands.asProfession(), (item) => !ctx.trip.loot.includes(item.serial))))
          continue;
        if (await playerPartyTurn(ctx)) continue;
        if (!initialized) {
          await initialize();
          initialized = true;
        }
        check();
        const attacker = ambusher;
        ambusher = undefined;
        if (await fightBack(ctx, attacker, defeat)) continue;
        if (await errands.shopPlayers()) continue;
        const personalLife = fighterLife(
          ctx,
          fighterDungeon(ctx, { defeat, heal, dress, unreachable, record: options.recordRun }),
          { sellLoot, bank, restock },
          options.decisions
        );
        if (await personalTurn(personalLife)) continue;
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
          await errands.returnToTown();
          options.decisions?.finish(
            checkpoint,
            returnDecision,
            'completed',
            'Returned to town and reconciled loot sales and bank deposits.'
          );
          returnDecision = null;
          await errands.afterReturn();
        }
        if (await errands.waitToReconsider()) continue;
        if (await errands.earnInstead()) continue;
        // Resume a dungeon run, or choose a life phase before leaving town.
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
        // Keep hunting other opponents while losses cool down.
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
        if (error instanceof Ambushed) {
          ambusher = error.attacker;
          continue;
        }
        if (error instanceof Retreat) {
          stats.retreats++;
          retreatedFrom(ctx);
          trip.pending = 'return';
          phase('retreating', error.message);
          session.setWarMode(false);
          drinkPotion();
          if (await recoverWithAid(ctx, heal)) trip.pending = 'hunt';
          continue;
        }
        if (!isSetback(session, error, !!options.stopping?.(), deadline)) throw error;
        // No weapon or healing and no money for them: paid work first (fighter-errands.ts).
        if (
          /No usable sword|No affordable stocked weapon|No healing supplies/.test(String(error)) &&
          (await escortOpportunity(ctx, status().gold + knownBankGold(checkpoint)).catch(() => false))
        )
          continue;
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
