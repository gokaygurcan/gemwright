import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';
import type { Position } from '@gemwright/network/world';

import { checkedDelay } from './action-purpose';
import { Blocked } from './blocked';
import { chaosOf } from './chaos';
import type { CharacterTemplate } from './config';
import type { DecisionCoordinator } from './decisions';
import { hadFun, strongestDrive } from './drives';
import { moongates, nearestGate } from './gates';
import { guildTurn } from './guilds';
import { housingTurn, leisureAtHome } from './house-life';
import { chooseLifePhase, config, finishLifeDecision, observeLifeWork } from './life-choice';
import { cityLandmarks, pickLocation, serviceLocations } from './locations';
import { forcedToWork } from './loop-watch';
import { travelByMoongate } from './moongate';
import { type createNavigator, distance } from './navigation';
import { meetNeeds } from './need-planning';
import { personalTurn } from './personal-turn';
import { playerPull } from './player-insight';
import { goalAllows, goalControlled } from './resident-goal';
import { scavenge } from './scavenge';
import { selfNow } from './self';
import { crowdFactor, pickWeighted, residentsNear } from './spread';
import type { Checkpoint } from './store';
import { learnedPlaceCost } from './strategy-learning';
import type { Terrain } from './terrain';
import { WALKING_LIMIT } from './tuning';
import { skillGrowth, workEvidence } from './work-evidence';
import { world } from './world';

export { skillCurve, skillProgress } from './life-choice';

// A resident's life between its own work and everything else (world.json `lifecycle`). At each
// natural break point (back in town, after banking) the current phase is checked; when it has run
// out, the next is chosen: Jev picks among valid phases when configured, the local rule picks by
// the configured time split shaded by temperament (sociable residents linger and travel, bold ones
// go to dungeons, restless ones switch more often). Work is the caller's own loop; the other
// phases run here. No more than a few residents switch in any minute, so the map never moves at once.
export interface LifeContext {
  session: PlayerSession;
  terrain: Terrain;
  template: CharacterTemplate;
  checkpoint: Checkpoint;
  city: string;
  position: () => Position;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  persist: () => void;
  navigate: ReturnType<typeof createNavigator>;
  decisions?: DecisionCoordinator;
  practise: (minutes: number) => Promise<unknown>;
  // Starts and plays out a dungeon run; false when none could start.
  dungeon?: () => Promise<boolean>;
  dungeonReady?: () => boolean;
  // The role's own town trip (a fighter sells, banks and restocks); otherwise a bank visit.
  errands?: () => Promise<void>;
}

const switches: number[] = [];
// Residents seen at a break point lately, by serial; the switch cap scales with them.
const residents = new Map<number, number>();

const between = ([low, high]: [number, number]) => low + Math.random() * (high - low);

// Walks there, or through the moongate nearest it when far.
async function goTo(ctx: LifeContext, point: { x: number; y: number }) {
  if (distance(ctx.position(), point) > WALKING_LIMIT) {
    const gate = nearestGate(point);
    if (distance(ctx.position(), moongates[gate]) > 2) await travelByMoongate(ctx, gate);
  }
  await ctx.navigate(point, 4);
}

// Passes time somewhere people gather in `city`: its bank or an inn or tavern, shifting about now
// and then. Conversation runs on its own whenever someone speaks.
// Loose valuables nearby are picked up in town too (scavenge.ts), between any other moves.
function pickUp(ctx: LifeContext) {
  const { session } = ctx;
  const serial = session.world.serial;
  const status = session.world.status;
  const pack = serial === null ? undefined : session.world.childrenOf(serial).find((i) => i.layer === Layer.Backpack);
  if (serial === null || !status || !pack) return Promise.resolve(false);
  return scavenge({ ...ctx, serial, status: () => session.world.status ?? status, backpack: () => pack.serial });
}

async function linger(ctx: LifeContext, city: string, until: number) {
  // Leisure in the home town is sometimes spent in one's own house (house-life.ts).
  if (city === ctx.city && (await leisureAtHome(ctx, until))) return true;
  const spots = [...serviceLocations(city, 'banker'), ...cityLandmarks(city, /\b(inn|tavern|pub|saloon)\b/i)];
  // Somewhere with company, not a crowd (spread.ts).
  const self = ctx.session.world.serial ?? undefined;
  const spot = pickWeighted(spots, (s) => crowdFactor(residentsNear(s, 12, self)));
  if (!spot) return false;
  const label = !('name' in spot) || spot.name === 'guide' ? `the ${city} bank` : spot.name;
  ctx.phase('leisure', `Passing time at ${label}`);
  await goTo(ctx, spot);
  if (distance(ctx.position(), spot) > 6) return false;
  while (Date.now() < until) {
    ctx.check();
    await checkedDelay(4000, ctx.check);
    if (await pickUp(ctx).catch(() => false)) continue;
    if (Math.random() < 0.08) {
      const here = ctx.position();
      const step = ctx.terrain.stand(
        here.x + Math.round(Math.random() * 6 - 3),
        here.y + Math.round(Math.random() * 6 - 3),
        here.z
      );
      if (step && distance(step, spot) <= 6) await ctx.navigate(step, 0).catch(() => {});
    }
  }
  return true;
}

// A plain bank visit, as a player checks in: "bank" opens the box, "balance" reports the gold.
async function bankVisit(ctx: LifeContext) {
  const bank = pickLocation(ctx.city, 'banker');
  if (!bank) return;
  ctx.phase('errands', `Checking in at the ${ctx.city} bank`);
  await goTo(ctx, bank);
  for (const line of ['bank', 'balance']) {
    ctx.session.say(line);
    await Bun.sleep(2500);
  }
}

function destination(ctx: LifeContext): string | undefined {
  const home = pickLocation(ctx.city, 'banker');
  const towns = Object.entries(world.cities)
    .filter(([name, entry]) => entry.enabled && entry.startingCity && name.toLowerCase() !== ctx.city.toLowerCase())
    .flatMap(([name]) => {
      const bank = pickLocation(name, 'banker');
      if (!bank) return [];
      // Nearer towns, towns with fewer residents about (spread.ts) and towns where players were
      // lately heard (player-insight.ts) are likelier.
      const busy = crowdFactor(residentsNear(bank, 60, ctx.session.world.serial ?? undefined), 4, 15);
      return [
        {
          name,
          weight:
            (busy * playerPull(bank)) /
            Math.max(
              200,
              (home ? distance(home, bank) : 1000) + learnedPlaceCost(ctx.checkpoint, ctx.session.world.map ?? 1, bank)
            )
        }
      ];
    });
  return pickWeighted(towns, (t) => t.weight)?.name;
}

// One break point. True when this turn went to a life phase other than work, so the caller's own
// work waits; false means work now. Every resident shares one event loop, so a turn spent on a
// phase lasts at least a second and always yields, even when the phase found nothing to do.
export async function lifeTurn(ctx: LifeContext): Promise<boolean> {
  if (goalControlled(ctx.session) && !goalAllows(ctx.session, 'optional')) return false;
  // The loop guard put it back to its job (loop-watch.ts).
  if (forcedToWork(ctx.session)) {
    finishLifeDecision(ctx, 'interrupted', 'Loop recovery preempted the life phase');
    return false;
  }
  observeLifeWork(ctx);
  const started = Date.now();
  if (await personalTurn(ctx)) return true;
  const need = await meetNeeds(ctx);
  if (need === 'handled') return true;
  if (need === 'work') {
    if (ctx.checkpoint.life?.phase !== 'work') {
      finishLifeDecision(ctx, 'interrupted', 'Supplying immediate needs preempted the life phase');
      ctx.checkpoint.life = { phase: 'work', until: Date.now() + 60_000 };
      ctx.phase('work', 'Earning and supplying my needs before optional plans');
    }
    return false;
  }
  if (await pickUp(ctx).catch(() => false)) return true;
  // A house to buy or visit, guild business (house-life.ts, guilds.ts).
  if ((await society(ctx, housingTurn)) || (await society(ctx, guildTurn))) return true;
  const other = await phaseTurn(ctx);
  if (other) await Bun.sleep(Math.max(0, 1000 - (Date.now() - started)));
  return other;
}

async function society(ctx: LifeContext, turn: (ctx: LifeContext) => Promise<boolean>) {
  try {
    return await turn(ctx);
  } catch (error) {
    // A house or guild errand the world prevents ends; the resident carries on with its life.
    if (ctx.session.phase !== 'ready') throw error;
    ctx.log(`${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function phaseTurn(ctx: LifeContext): Promise<boolean> {
  const now = Date.now();
  while (switches.length && (switches[0] ?? 0) < now - 60_000) switches.shift();
  let life = ctx.checkpoint.life;
  if (!life || now >= life.until) {
    finishLifeDecision(ctx, 'failed', 'Phase expired without its expected outcome');
    // The cap is per 50 residents in this runtime, so a large population still changes at a
    // natural pace.
    const self = ctx.session.world.serial ?? 0;
    residents.set(self, now);
    for (const [serial, seen] of residents) if (now - seen > 10 * 60_000) residents.delete(serial);
    const cap = config.maxSwitchesPerMinute * Math.max(1, Math.ceil(residents.size / 50));
    if (life && switches.length >= cap) {
      // Too many residents changing at once: carry on a little longer. A finished phase (errands,
      // a visit, a dungeon run) is not repeated; the minute goes to work.
      if (life.until === 0) life.phase = 'work';
      life.until = now + 60_000;
    } else {
      const choice = await chooseLifePhase(ctx);
      let phase = choice.phase;
      // A break (leisure, a visit) is earned: only after the resident grew richer or more skilled
      // since its last one (self.ts), and it stays short. Otherwise it works.
      const me = selfNow(ctx.session, ctx.checkpoint, ctx.template);
      const last = ctx.checkpoint.lastBreak;
      if (
        (phase === 'leisure' || phase === 'visit') &&
        last &&
        me.wealth <= last.wealth &&
        me.skillTotal <= last.skillTotal
      )
        phase = 'work';
      if (phase !== choice.phase)
        ctx.decisions?.finish(
          ctx.checkpoint,
          choice.pick,
          'interrupted',
          'Phase overridden: work must earn the next break'
        );
      if (phase === 'leisure' || phase === 'visit')
        ctx.checkpoint.lastBreak = { at: now, wealth: me.wealth, skillTotal: me.skillTotal };
      const restless = ctx.template.behavior.temperament?.restlessness ?? 1;
      // Chaos (chaos.ts) stretches or cuts a phase short by up to half its length either way.
      const swing = 1 + (Math.random() * 2 - 1) * 0.5 * chaosOf(ctx.session);
      const minutes = (between(config.minutes[phase]) * swing) / restless;
      life = {
        phase,
        decision: phase === choice.phase ? (choice.pick ?? undefined) : undefined,
        before: workEvidence(ctx.session, ctx.checkpoint),
        until: now + (phase === 'leisure' || phase === 'visit' ? Math.min(10, minutes) : minutes) * 60_000
      };
      if (phase === 'visit') life.city = destination(ctx);
      ctx.checkpoint.life = life;
      switches.push(now);
      if (phase === 'leisure' || phase === 'visit') hadFun(ctx.session.world.serial ?? 0);
      const why = strongestDrive(ctx, phase);
      ctx.phase(
        'life',
        `Next: ${phase}${life.city ? ` to ${life.city}` : ''} for about ${Math.round((life.until - now) / 60_000)} minutes${why ? `, for ${why}` : ''}`
      );
    }
    ctx.persist();
  }
  const done = (
    status: 'completed' | 'failed' | 'interrupted' = 'completed',
    note = `Life phase ${life?.phase} finished`
  ) => {
    finishLifeDecision(ctx, status, note);
    if (ctx.checkpoint.life) ctx.checkpoint.life.until = 0;
    ctx.persist();
  };
  try {
    switch (life.phase) {
      case 'work':
        return false;
      case 'dungeon': {
        const ran = (await ctx.dungeon?.()) ?? false;
        done(ran ? 'completed' : 'failed', ran ? 'Dungeon run executed' : 'No dungeon run could start');
        return ran;
      }
      case 'errands': {
        const holdings = () =>
          JSON.stringify([
            workEvidence(ctx.session, ctx.checkpoint),
            ctx.checkpoint.funds?.at,
            ctx.checkpoint.bankSeen?.at
          ]);
        const before = holdings();
        await (ctx.errands ? ctx.errands() : bankVisit(ctx));
        const changed = holdings() !== before;
        done(
          changed ? 'completed' : 'failed',
          changed ? 'Observed a change from town errands' : 'Errands produced no observed result'
        );
        return changed;
      }
      case 'leisure': {
        const stayed = await linger(ctx, ctx.city, life.until);
        done(
          stayed ? 'completed' : 'failed',
          stayed ? 'Reached the leisure location and finished the stay' : 'Leisure location unavailable'
        );
        return stayed;
      }
      case 'visit': {
        const town = life.city;
        let visited = false;
        if (town) {
          ctx.phase('visit', `Travelling to ${town} for a while`);
          try {
            visited = await linger(ctx, town, life.until);
          } finally {
            // However the stay went, the visit ends at home.
            const home = pickLocation(ctx.city, 'banker');
            if (home && ctx.session.phase === 'ready') {
              ctx.phase('visit', `Heading home to ${ctx.city}`);
              await goTo(ctx, home).catch((error) => {
                visited = false;
                ctx.log(`The way home failed: ${error}`);
              });
              if (distance(ctx.position(), home) > 6) visited = false;
            } else visited = false;
          }
        }
        done(
          visited ? 'completed' : 'failed',
          visited ? 'Visited the selected town and finished the stay' : 'Visit could not execute'
        );
        return visited;
      }
      case 'practice': {
        const started = Date.now();
        const before = workEvidence(ctx.session, ctx.checkpoint);
        await ctx.practise(Math.min(5, Math.max(1, (life.until - Date.now()) / 60_000)));
        // Nothing to practise right now (no usable skill, tool or material): the rest of the phase
        // goes to the resident's own work, which trains its primary skills, so the time the skill
        // curve gave to training is not lost to a leisure or visit pick.
        if (skillGrowth(before, workEvidence(ctx.session, ctx.checkpoint)) > 0)
          finishLifeDecision(ctx, 'completed', 'Observed base skill growth during practice');
        if (Date.now() - started < 5000) {
          finishLifeDecision(ctx, 'failed', 'No practice could execute; returning to work');
          life.phase = 'work';
          ctx.persist();
          return false;
        }
        return true;
      }
      default:
        done();
        return false;
    }
  } catch (error) {
    // A phase the world prevents (no route, no banker) ends; the resident does something else.
    if (!(error instanceof Blocked) || ctx.session.phase !== 'ready') {
      done('interrupted', error instanceof Error ? error.message : String(error));
      throw error;
    }
    ctx.log(`Life phase ${life.phase} ended early: ${error.message}`);
    done('failed', error.message);
    return false;
  }
}
