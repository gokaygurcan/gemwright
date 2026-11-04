import { gold } from '@gemwright/common/game/items';

import { absence } from './absence';
import { tally } from './activity';
import { recoverWithAid } from './aid-recovery';
import { knownBankGold } from './bank-gold';
import { Blocked, type BlockedReason, blockedReason } from './blocked';
import { atGround, fightBack, groundOf, nextGround, patrolPoints, retreatedFrom, travelToGround } from './cemeteries';
import type { DecisionPick } from './decisions';
import { dungeonTurn } from './dungeon-turn';
import { escortOpportunity } from './escort';
import { actionScope, checkAction, yieldForInteraction } from './execution-session';
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
import { createCorpseLooter, fellAlongside } from './fighter-loot';
import { createFighterRecovery } from './fighter-recovery';
import { checkFighter } from './fighter-safety';
import { registerFighterSocial } from './fighter-social';
import { createFighterInventory, initializeFighter } from './fighter-startup';
import { createFighterTown } from './fighter-town';
import { fieldUpkeep, planTownTrip } from './fighter-trip';
import { residentTurn } from './goal-turn';
import { lifeTurn } from './life';
import { logger } from './log';
import { watchStep } from './loop-watch';
import { createMountController, mountedNavigator } from './mounts';
import { createNavigator, distance } from './navigation';
import { playerPartyTurn } from './player-party';
import { observeResident } from './resident-observation';
import type { ResidentOptions } from './resident-options';
import { SessionBreak } from './session-habits';
import { isSetback, passSetback } from './setback';
import { trainSupportingSkill } from './skill-training';
import { Terrain } from './terrain';
import { TownChanged, townFor } from './towns';

export async function runFighter(options: ResidentOptions) {
  const { session, template } = options;
  const serial = session.world.serial;
  if (serial === null || session.world.map !== 1) throw new Error('Fighter needs Trammel');
  const home = homeOf(townFor(session, 'fighter'), () => session.world.position ?? { x: 0, y: 0 });
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
  const log = (message: string) => logger('fighter').info(`[${tag}] ${message}`);
  const persist = () => {
    checkAction(session);
    options.save(checkpoint);
  };
  const phase = (value: string, text: string) => {
    checkAction(session);
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
  let self: FighterContext | undefined;
  const check = () => {
    if (!self) throw new Error('Fighter context is not initialized');
    checkFighter(self, combatAssessment, options.stopping);
  };
  session.setActivityCheck?.(check);
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
    // A fighter's road is full of its prey: steering around the undead and waiting for them to move
    // on is what left fighters standing still in front of the very monsters they came to kill. It
    // walks its route; checkFighter engages what attacks it (or retreats when it cannot win).
    wary: () => false,
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
  const { backpack, contents, count, open, refreshBackpack } = createFighterInventory(session, serial);
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
  const ctx: FighterContext = {
    session,
    home,
    template,
    terrain,
    checkpoint,
    trip,
    serial,
    deadline,
    backpack,
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
        checkpoint
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
    const before = new Set(session.world.deaths.keys());
    const defeated = await actionScope(session, 'combat', 'Defeat observed opponent', () =>
      fightOpponent(ctx, combat, opponent, options.decisions, options.stopping)
    );
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
    // The corpse serial can arrive as 0 (or not at all): the looter finds the fresh corpse where
    // the opponent fell instead of walking away from a kill with the gold still on it.
    await lootCorpse(death);
    for (const other of fellAlongside(ctx, before, defeated.serial)) await lootCorpse(other);
    delete trip.encounter;
    persist();
  };
  registerFighterSocial(ctx, defeat, heal);
  const initialize = () => initializeFighter(ctx);
  let ambusher: Ambushed['attacker'] | undefined;
  let initialized = false;
  let outcome = 'completed';
  let blocked: BlockedReason | undefined;
  try {
    let turnAt = 0;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.max(0, turnAt + 250 - Date.now()));
      turnAt = Date.now();
      try {
        await actionScope(session, 'work', 'fighter turn', async () => {
          if (ambusher) {
            const attacker = ambusher;
            ambusher = undefined;
            if (await actionScope(session, 'combat', 'Respond to attacker', () => fightBack(ctx, attacker, defeat)))
              return;
          }
          if (!initialized) {
            await initialize();
            initialized = true;
          }
          const below = fighterDungeon(ctx, { defeat, heal, dress, unreachable, record: options.recordRun });
          const personalLife = fighterLife(ctx, below, { sellLoot, bank, restock }, options.decisions);
          const consumed = await residentTurn(errands.asProfession(), {
            trade: 'fighter',
            keep: (item) => !ctx.trip.loot.includes(item.serial),
            life: personalLife,
            settle: () => errands.returnToTown(),
            recover: async () => {
              await recover();
              await rest();
            },
            prepare: async () => {
              await errands.tidyAndSell();
              await restock();
            },
            optional: async () =>
              (await playerPartyTurn(ctx)) || (await errands.shopPlayers()) || (await lifeTurn(personalLife))
          });
          // The turn guard runs even when the plan consumed the turn: bounded recovery, goal
          // deadlines and loop-watch's pending interrupt all rely on being checked here.
          check();
          if (consumed) return;
          const attacker = ambusher;
          ambusher = undefined;
          if (await fightBack(ctx, attacker, defeat)) return;
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
          if (await errands.waitToReconsider()) return;
          if (await errands.earnInstead()) return;
          if (await dungeonTurn(below, false)) return;
          const town = { sellLoot, bank, restock };
          if (!atGround(ctx) && (await lifeTurn(fighterLife(ctx, below, town, options.decisions)))) return;
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
            return;
          }
          activeDecision = choice.kind === 'avoid' ? null : choice.pick;
          const opponent = choice.kind === 'fight' ? choice.opponent : undefined;
          if (!opponent) {
            // An empty cemetery is crowded or picked clean: move on, and leave it a while (absence.ts).
            if (++idlePatrols > 6 + (template.behavior.temperament?.patrolOffset ?? 0)) {
              idlePatrols = 0;
              absence(serial).note('ground', groundOf(trip).center);
              trip.ground = options.overland
                ? ({ Britain: 'Yew', Yew: 'Britain', Cove: 'Vesper', Vesper: 'Cove' }[trip.ground ?? 'Britain'] ??
                  'Britain')
                : nextGround(ctx);
              persist();
              phase('changing-ground', `Nothing to hunt here lately; moving on to ${trip.ground}`);
              return;
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
            return;
          }
          await defeat(opponent);
          options.decisions?.finish(
            checkpoint,
            activeDecision,
            'completed',
            `Observed selected opponent ${opponent.serial} die and reconciled its corpse. Health ${status().hits}/${status().maxHits}; gold ${count(gold)}.`
          );
          activeDecision = null;
        });
      } catch (error) {
        if (await yieldForInteraction(session, error)) continue;
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
        if (error instanceof Blocked && error.reason === 'halted' && session.phase === 'ready') {
          await Bun.sleep(2000);
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
          // A road to this ground that cannot be walked (a gate pair gone bad, no route at all) is
          // grounds to hunt elsewhere for a while: "another course" means another graveyard.
          if (/moongate|no route|no public route|walk/i.test(error.message)) {
            const elsewhere = nextGround(ctx);
            if (elsewhere !== trip.ground) {
              log(`The road to the ${trip.ground} is closed; hunting at the ${elsewhere} instead`);
              trip.ground = elsewhere;
            }
          }
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
          // The retreat itself can be interrupted (hurt again on the way, a danger check inside the
          // recovery): that ends this turn, not the session — the return stays pending and the next
          // turn leaves. Ending the run here made every street fight a logout/login.
          try {
            if (await recoverWithAid(ctx, heal)) trip.pending = 'hunt';
          } catch (interrupted) {
            if (session.phase !== 'ready') throw interrupted;
            ctx.log(`Retreat interrupted: ${interrupted instanceof Error ? interrupted.message : String(interrupted)}`);
          }
          continue;
        }
        if (!isSetback(session, error, !!options.stopping?.(), deadline)) throw error;
        if (
          /No usable sword|No affordable stocked weapon|No healing supplies/.test(String(error)) &&
          (await escortOpportunity(ctx, status().gold + knownBankGold(checkpoint)).catch(() => false))
        )
          continue;
        await setback(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    if (error instanceof SessionBreak || error instanceof TownChanged) throw error;
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
