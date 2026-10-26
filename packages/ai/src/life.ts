import { skillId } from '@gemwright/common/skills';

import { checkedDelay } from './action-purpose';
import { Blocked } from './blocked';
import { chaosOf } from './chaos';
import type { CharacterTemplate } from './config';
import { type DecisionCoordinator, decisionGuard, decisionState } from './decisions';
import { guildTurn } from './guilds';
import { housingTurn, leisureAtHome } from './house-life';
import { cityLandmarks, pickLocation, serviceLocations } from './locations';
import { moongates, nearestGate, travelByMoongate } from './moongate';
import { type createNavigator, distance } from './navigation';
import { meetNeeds } from './need-planning';
import { goalPhaseBias } from './personal-goals';
import { personalTurn } from './personal-turn';
import { playerPull } from './player-insight';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Position } from './protocol/world';
import { scavenge } from './scavenge';
import { trainable } from './skill-training';
import { crowdFactor, pickWeighted, residentsNear } from './spread';
import type { Checkpoint } from './store';
import { learnedPlaceCost } from './strategy-learning';
import type { Terrain } from './terrain';
import { type LifePhase, world } from './world';

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
  // Home city name.
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

const config = world.lifecycle ?? {
  mix: 'balanced',
  mixes: { balanced: { work: 40, dungeon: 15, errands: 10, leisure: 15, visit: 10, practice: 10 } },
  minutes: {
    work: [20, 45],
    dungeon: [20, 45],
    errands: [3, 10],
    leisure: [5, 15],
    visit: [15, 40],
    practice: [5, 15]
  },
  maxSwitchesPerMinute: 5
};
const mix = config.mixes[config.mix];
if (!mix) throw new Error(`Unknown lifecycle mix ${config.mix}`);
const phases = Object.keys(mix) as LifePhase[];
const describe: Record<LifePhase, string> = {
  work: 'Get on with my own work',
  dungeon: 'Go on a dungeon run, alone or with a party',
  errands: 'Run errands in town: bank, sell, restock',
  leisure: 'Spend some time at the bank or an inn among other people',
  visit: 'Travel to another town for a while, then come home',
  practice: 'Practise a supporting skill or rest somewhere safe'
};
const switches: number[] = [];
// Residents seen at a break point lately, by serial; the switch cap scales with them.
const residents = new Map<number, number>();
const WALKING_LIMIT = 300;

const between = ([low, high]: [number, number]) => low + Math.random() * (high - low);
const mean = ([low, high]: [number, number]) => (low + high) / 2;

// Picks from the time split: a phase's chance is its share of time over its mean length, so the
// time spent comes out at the configured shares.
// How far a resident's build has come: the mean base of its primary skills, 0 to 1.
export function skillProgress(ctx: Pick<LifeContext, 'session' | 'template'>): number {
  const primaries = ctx.template.archetype?.primarySkills ?? [];
  if (!primaries.length) return 0.5;
  const sum = primaries.reduce((n, name) => n + (ctx.session.world.skills.get(skillId(name))?.base ?? 0), 0);
  return Math.min(1, sum / primaries.length / 100);
}

// The skill curve: the lower the skills, the more the time goes to work and practice (where skills
// rise); the higher, the more to leisure and visits (long trips, nearly none early on). At progress
// p: work x(1 + 0.5(1-p)), practice x(1 + (1-p)), leisure x(0.3 + 0.7p), visit x p^2.
export function skillCurve(p: number): Partial<Record<LifePhase, number>> {
  return { work: 1 + 0.5 * (1 - p), practice: 2 - p, leisure: 0.3 + 0.7 * p, visit: p * p };
}

function localPick(ctx: LifeContext, valid: LifePhase[]): LifePhase {
  const { sociability, riskTolerance } = ctx.template.behavior;
  const curve = skillCurve(skillProgress(ctx));
  const shade: Partial<Record<LifePhase, number>> = {
    work: curve.work,
    practice: curve.practice,
    leisure: (0.5 + sociability) * (curve.leisure ?? 1),
    visit: (0.5 + sociability) * (curve.visit ?? 1),
    dungeon: 0.5 + riskTolerance
  };
  const weights = valid.map(
    (p) => ((mix?.[p] ?? 0) / mean(config.minutes[p])) * (shade[p] ?? 1) * goalPhaseBias(ctx, p)
  );
  let roll = Math.random() * weights.reduce((sum, w) => sum + w, 0);
  for (const [i, p] of valid.entries()) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return p;
  }
  return 'work';
}

async function choose(ctx: LifeContext): Promise<LifePhase> {
  // Practice only while a supporting skill can still rise (skill-training.ts): maxed ones are done.
  const valid = phases.filter((p) =>
    p === 'dungeon'
      ? !!ctx.dungeon && !!ctx.dungeonReady?.()
      : p === 'practice'
        ? trainable(ctx.session, ctx.template.archetype).length > 0
        : true
  );
  let baseline = localPick(ctx, valid);
  // A change of plans (chaos.ts): a planned visit or leisure sometimes becomes something else.
  if (['visit', 'leisure'].includes(baseline) && Math.random() < chaosOf(ctx.session) / 3) {
    const instead = localPick(
      ctx,
      valid.filter((p) => p !== baseline)
    );
    ctx.log(`Changed my mind: ${instead} instead of ${baseline}`);
    baseline = instead;
  }
  if (!ctx.decisions) return baseline;
  const pick = await ctx.decisions.choose({
    kind: 'life-phase',
    checkpoint: ctx.checkpoint,
    observationRevision: ctx.session.world.revision,
    state: decisionState(ctx.session, ctx.template, ctx.checkpoint, {
      previous: ctx.checkpoint.life?.phase ?? 'none',
      timeSplit: mix,
      // How far the build has come (0-1): low means train, high means enjoy (skillCurve).
      skillProgress: Number(skillProgress(ctx).toFixed(2)),
      home: ctx.city
    }),
    candidates: valid.map((p) => ({ id: p, description: describe[p], valid: () => true })),
    baseline,
    stillCurrent: decisionGuard(ctx.session)
  });
  const chosen = (valid.find((p) => p === pick?.id) ?? baseline) as LifePhase;
  ctx.decisions.finish(ctx.checkpoint, pick, 'completed', `Next life phase: ${chosen}`);
  return chosen;
}

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
  if (city === ctx.city && (await leisureAtHome(ctx, until))) return;
  const spots = [...serviceLocations(city, 'banker'), ...cityLandmarks(city, /\b(inn|tavern|pub|saloon)\b/i)];
  // Somewhere with company, not a crowd (spread.ts).
  const self = ctx.session.world.serial ?? undefined;
  const spot = pickWeighted(spots, (s) => crowdFactor(residentsNear(s, 12, self)));
  if (!spot) return;
  const label = !('name' in spot) || spot.name === 'guide' ? `the ${city} bank` : spot.name;
  ctx.phase('leisure', `Passing time at ${label}`);
  // A spot out of reach (a closed door, a route that does not resolve): pass the time here.
  await goTo(ctx, spot).catch((error) => {
    if (ctx.session.phase !== 'ready') throw error;
    ctx.log(`Could not reach ${label}: ${error instanceof Error ? error.message : error}; staying here`);
  });
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
  const started = Date.now();
  if (await personalTurn(ctx)) return true;
  const need = await meetNeeds(ctx);
  if (need === 'handled') return true;
  if (need === 'work') {
    if (ctx.checkpoint.life?.phase !== 'work') {
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
      const phase = await choose(ctx);
      const restless = ctx.template.behavior.temperament?.restlessness ?? 1;
      // Chaos (chaos.ts) stretches or cuts a phase short by up to half its length either way.
      const swing = 1 + (Math.random() * 2 - 1) * 0.5 * chaosOf(ctx.session);
      life = { phase, until: now + ((between(config.minutes[phase]) * swing) / restless) * 60_000 };
      if (phase === 'visit') life.city = destination(ctx);
      ctx.checkpoint.life = life;
      switches.push(now);
      ctx.phase(
        'life',
        `Next: ${phase}${life.city ? ` to ${life.city}` : ''} for about ${Math.round((life.until - now) / 60_000)} minutes`
      );
    }
    ctx.persist();
  }
  const done = () => {
    if (ctx.checkpoint.life) ctx.checkpoint.life.until = 0;
    ctx.persist();
  };
  try {
    switch (life.phase) {
      case 'work':
        return false;
      case 'dungeon': {
        const ran = (await ctx.dungeon?.()) ?? false;
        done();
        return ran;
      }
      case 'errands':
        await (ctx.errands ? ctx.errands() : bankVisit(ctx));
        done();
        return true;
      case 'leisure':
        await linger(ctx, ctx.city, life.until);
        return true;
      case 'visit': {
        const town = life.city;
        if (town) {
          ctx.phase('visit', `Travelling to ${town} for a while`);
          try {
            await linger(ctx, town, life.until);
          } finally {
            // However the stay went, the visit ends at home.
            const home = pickLocation(ctx.city, 'banker');
            if (home && ctx.session.phase === 'ready') {
              ctx.phase('visit', `Heading home to ${ctx.city}`);
              await goTo(ctx, home).catch((error) => ctx.log(`The way home failed: ${error}`));
            }
          }
        }
        done();
        return true;
      }
      case 'practice': {
        const started = Date.now();
        await ctx.practise(Math.min(5, Math.max(1, (life.until - Date.now()) / 60_000)));
        // Nothing to practise right now (no usable skill, tool or material): the rest of the phase
        // goes to the resident's own work, which trains its primary skills, so the time the skill
        // curve gave to training is not lost to a leisure or visit pick.
        if (Date.now() - started < 5000) {
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
    if (!(error instanceof Blocked) || ctx.session.phase !== 'ready') throw error;
    ctx.log(`Life phase ${life.phase} ended early: ${error.message}`);
    done();
    return false;
  }
}
