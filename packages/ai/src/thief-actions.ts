import { gold } from '@gemwright/common/items';

import { offersBank, openBankBox, queryBankBalance } from './bank-gold';
import { Blocked } from './blocked';
import { recognised } from './fighter-prey';
import { type ServiceType, serviceLocations } from './locations';
import { approachMobile } from './mobile-approach';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import type { Entity } from './protocol/world';
import {
  dungeonMark,
  groundFor,
  groundPatrols,
  markCandidates,
  retreatPoint,
  snoopTargets,
  type TheftGround,
  undeadMark,
  verifyDungeonMark,
  verifyMark
} from './thief-marks';
import { createThiefSkills, type StealOutcome, type ThiefSkillState } from './thief-skills';
import { sellTo } from './vendor-trade';
import { reachRegion } from './work-areas';

// The thief's two activities and the trip that carries them between town and a theft ground. The
// rules its actions run on live in thief-skills.ts (Snooping, Stealing, Hiding, Stealth) and the
// marks it dares approach in thief-marks.ts.
//
// A thief lives in its home town and takes theft trips to the cemetery nearest it: it cases a lone
// zombie or skeleton, hides, sneaks in walking, steals from its pack, breaks away from the aggro it
// just earned and returns home to bank. Creature backpacks refuse players on the pinned shard and
// town NPCs, players and vendors refuse both skills, so lone graveyard undead are the marks and
// pack animals are the packs that remain snoopable. Every server interaction is observed and
// bounded, and an unanswered action is never replayed.
export interface ThiefActions {
  attempt(ctx: ProfessionContext): Promise<boolean>;
  dungeonStep(ctx: ProfessionContext, radius: number): Promise<boolean>;
  afterDungeon(): void;
}

// The thief's own possessions, never banked: a spellbook and the magery reagents training buys.
const keep = new Set([0x0efa, 0x0f84, 0x0f85, 0x0f86, 0x0f88, 0x0f8d, 0x0f8c, 0x0f7b]);
const TRIP_MS = 5 * 60_000;
const TRIP_THEFTS = 2;
const TRIP_ATTEMPTS = 6;
const TRIP_FAILURES = 4;
const SWEEPS = 3;
const REST_MS = 4 * 60_000;
const GROUND_RETRY_MS = 10 * 60_000;
const HEALTH_FLOOR = 0.6;
// Stored items in the bank box beyond which some are taken out to sell (ServUO allows 125).
const BOX_FULL = 100;
// Vendor kinds a thief offers its takings to, most likely buyers first.
const SELL_TO: ServiceType[] = [
  'jeweler',
  'weaponsmith',
  'blacksmith',
  'tailor',
  'mage',
  'alchemist',
  'bowyer',
  'tinker'
];

interface Trip {
  ground: TheftGround;
  startedAt: number;
  thefts: number;
  attempts: number;
  failures: number;
  sweeps: number;
}

interface ThiefState extends ThiefSkillState {
  mode: 'home' | 'trip' | 'work' | 'back';
  trip: Trip | null;
  nextTripAt: number;
  nextBankAt: number;
}

export function createThiefActions(options: { peers?: ReadonlyMap<number, string> } = {}): ThiefActions {
  const blockedMarks = new Set<number>();
  const emptyMarks = new Set<number>();
  const unreachableMarks = new Set<number>();
  const unknownMarks = new Set<number>();
  const casedPacks = new Set<number>();
  const blockedGrounds = new Set<string>();
  const state: ThiefState = {
    mode: 'home',
    trip: null,
    hidden: false,
    sneaking: false,
    sneakSteps: 0,
    nextSkillAt: 0,
    hideRetryAt: 0,
    sneakRetryAt: 0,
    nextTripAt: 0,
    nextBankAt: 0
  };
  const skills = createThiefSkills(state);
  let patrol = 0;

  // Stolen loot: everything the thief carries that is not a reagent or its spellbook.
  const loot = (ctx: ProfessionContext) => ctx.carried().filter((item) => !keep.has(item.graphic));
  const homeAnchor = (ctx: ProfessionContext) => serviceLocations(ctx.city, 'banker')[0];

  // Gold is lost on death and vendors charge the bank directly, so nothing worth keeping stays in
  // the pack across trips; graveyard refuse was already dropped where it was taken.
  async function bank(ctx: ProfessionContext): Promise<void> {
    const { session } = ctx;
    const home = homeAnchor(ctx);
    try {
      if (home) {
        await reachRegion(ctx, home);
        await ctx.navigate(home, 4);
      }
      for (const mobile of session.world.entities.values()) {
        if (mobile.kind !== 'mobile' || mobile.notoriety !== 7 || !mobile.position) continue;
        if (distance(ctx.position(), mobile.position) > 12) continue;
        if (!(await offersBank(session, mobile.serial))) continue;
        let box: number;
        try {
          box = await openBankBox(ctx, mobile.serial);
        } catch (error) {
          if (session.phase !== 'ready') throw error;
          ctx.log(`Banker unavailable: ${error instanceof Error ? error.message : error}`);
          continue;
        }
        // A box near ServUO's 125-item limit gives up some stored takings to sell on the next trip.
        const boxed = session.world.childrenOf(box).filter((item) => item.graphic !== gold);
        if (boxed.length >= BOX_FULL)
          for (const item of boxed.slice(0, 20)) {
            ctx.check();
            await session.moveItem(item.serial, ctx.backpack());
            await Bun.sleep(700);
          }
        let banked = 0;
        let stored = 0;
        for (const item of loot(ctx)) {
          ctx.check();
          await session.moveItem(item.serial, box);
          if (item.graphic === gold) banked += item.amount ?? 1;
          else stored++;
          await Bun.sleep(700);
        }
        await queryBankBalance(ctx, mobile.serial);
        ctx.progress.banked = (ctx.progress.banked ?? 0) + banked;
        ctx.progress.stored = (ctx.progress.stored ?? 0) + stored;
        ctx.phase('thief-bank', `Banked ${banked} gold and ${stored} item(s) with the ${ctx.city} banker`);
        return;
      }
      ctx.log('No banker offered an open bank box');
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      ctx.log(`Banking left carried loot unbanked: ${error instanceof Error ? error.message : error}`);
    }
    state.nextBankAt = Date.now() + 60_000;
  }

  // Turns takings into gold before banking, only while innocent: an innocent player sells, a grey
  // one waits for the flag to clear. Each town vendor kind is offered what it buys.
  async function sellTakings(ctx: ProfessionContext): Promise<void> {
    const self = ctx.session.world.entities.get(ctx.serial);
    if (self?.notoriety !== 1) return;
    const takings = (item: Entity) => item.graphic !== gold && !keep.has(item.graphic);
    // Remembers the best offer per item kind; sells where the offer is within a tenth of the best
    // known, so a gem waits for the jeweler rather than going cheap to the first vendor asked.
    ctx.checkpoint.prices ??= {};
    const prices = ctx.checkpoint.prices;
    const worth = (service: ServiceType) => (item: Entity, price: number) => {
      if (!takings(item)) return false;
      const each = price / Math.max(1, item.amount ?? 1);
      const known = prices[item.graphic];
      if (!known || each > known.price) prices[item.graphic] = { service, price: each };
      return each >= 0.9 * (prices[item.graphic]?.price ?? each);
    };
    for (const service of SELL_TO) {
      if (!loot(ctx).some(takings)) break;
      try {
        const earned = await sellTo({ ...ctx, city: ctx.city }, service, worth(service));
        if (earned > 0) {
          ctx.progress.sold = (ctx.progress.sold ?? 0) + earned;
          ctx.phase('thief-sell', `Sold takings to a ${service} for ${earned} gold`);
        }
      } catch (error) {
        if (ctx.session.phase !== 'ready') throw error;
      }
    }
  }

  async function atHome(ctx: ProfessionContext): Promise<boolean> {
    const home = homeAnchor(ctx);
    if (home && distance(ctx.position(), home) > 40) {
      ctx.phase('thief-travel', `Returning to ${home.city}`);
      await ctx.navigate(home, 8);
      return true;
    }
    if (loot(ctx).length && Date.now() >= state.nextBankAt) {
      await sellTakings(ctx);
      await bank(ctx);
      return true;
    }
    if (Date.now() < state.nextTripAt) {
      const pack = snoopTargets(ctx.session.world, ctx.serial, options.peers).find(
        ({ owner }) => !casedPacks.has(owner.serial) && owner.position && distance(ctx.position(), owner.position) <= 18
      );
      if (!pack) return false;
      casedPacks.add(pack.owner.serial);
      ctx.phase('thief-snoop', `Casing the pack of ${pack.owner.name ?? 'a nearby animal'}`);
      try {
        // Container_Snoop allows the peek from the tile next to the container.
        await approachMobile(ctx, pack.owner.serial);
      } catch (error) {
        if (ctx.session.phase !== 'ready') throw error;
        ctx.log(
          `Could not reach the pack of ${pack.owner.name ?? 'a nearby animal'}: ${error instanceof Error ? error.message : error}`
        );
        return true;
      }
      await skills.snoop(ctx, pack.owner, pack.pack);
      return true;
    }
    const ground = groundFor(home ?? ctx.position());
    if (blockedGrounds.has(ground.name)) {
      state.nextTripAt = Date.now() + GROUND_RETRY_MS;
      return false;
    }
    state.trip = { ground, startedAt: Date.now(), thefts: 0, attempts: 0, failures: 0, sweeps: 0 };
    state.mode = 'trip';
    return travel(ctx);
  }

  async function travel(ctx: ProfessionContext): Promise<boolean> {
    const trip = state.trip;
    if (!trip) {
      state.mode = 'home';
      return false;
    }
    ctx.phase('thief-travel', `Walking to the ${trip.ground.name} cemetery for marks`);
    try {
      await reachRegion(ctx, trip.ground.center);
      await ctx.navigate(trip.ground.center, 6);
    } catch (error) {
      if (ctx.session.phase !== 'ready') throw error;
      blockedGrounds.add(trip.ground.name);
      state.nextTripAt = Date.now() + GROUND_RETRY_MS;
      state.mode = 'back';
      ctx.log(`No theft ground this run: ${error instanceof Error ? error.message : error}`);
      return true;
    }
    state.mode = 'work';
    // The trip's working time starts at the ground, not in town.
    trip.startedAt = Date.now();
    ctx.phase('thief-casing', `Looking for a lone zombie or skeleton at the ${trip.ground.name} cemetery`);
    return true;
  }

  async function returnHome(ctx: ProfessionContext): Promise<boolean> {
    const home = homeAnchor(ctx);
    if (home) {
      try {
        await reachRegion(ctx, home);
        await ctx.navigate(home, 4);
      } catch (error) {
        if (ctx.session.phase !== 'ready') throw error;
        ctx.log(`The way home was blocked: ${error instanceof Error ? error.message : error}`);
      }
    }
    state.mode = 'home';
    state.trip = null;
    state.nextTripAt = Date.now() + REST_MS;
    ctx.phase('thief-returned', 'Back in town with what the trip earned');
    return true;
  }

  // Single-clicks an unseen mark once so a stronger variant sharing a body graphic is never
  // approached.
  async function chooseMark(
    ctx: ProfessionContext,
    marks: Entity[],
    verify: (entity: Entity) => boolean | undefined = verifyMark
  ): Promise<Entity | undefined> {
    const { session } = ctx;
    for (const mark of marks.slice(0, 4)) {
      if (blockedMarks.has(mark.serial) || emptyMarks.has(mark.serial) || unreachableMarks.has(mark.serial)) continue;
      if (unknownMarks.has(mark.serial)) continue;
      const verified = verify(mark);
      if (verified === true) return mark;
      if (verified === false) {
        blockedMarks.add(mark.serial);
        continue;
      }
      try {
        await session.inspect(mark.serial);
      } catch (error) {
        if (session.phase !== 'ready') throw error;
      }
      const named = session.world.entities.get(mark.serial);
      if (!named?.name) {
        unknownMarks.add(mark.serial);
        continue;
      }
      if (verify(named) === true) return named;
      blockedMarks.add(mark.serial);
    }
    return undefined;
  }

  async function closeIn(ctx: ProfessionContext, mark: Entity) {
    const stealthed = state.hidden && state.sneaking;
    // Walking hidden without a stealth budget reveals the thief on the first step.
    if (state.hidden && !stealthed) state.hidden = false;
    try {
      await approachMobile({ ...ctx, navigate: stealthed ? skills.sneakNavigator(ctx) : ctx.navigate }, mark.serial);
    } catch (error) {
      if (ctx.session.phase !== 'ready') throw error;
      unreachableMarks.add(mark.serial);
      ctx.log(`Mark ${mark.name ?? mark.serial} is out of reach: ${error instanceof Error ? error.message : error}`);
    }
  }

  async function breakAway(ctx: ProfessionContext, mark: Entity) {
    ctx.phase('thief-retreat', `Breaking away from ${mark.name ?? 'a mark'}`);
    state.hidden = false;
    state.sneaking = false;
    const from = ctx.position();
    const point = mark.position ? retreatPoint(ctx.terrain, from, mark.position) : undefined;
    try {
      await ctx.navigate(point ?? state.trip?.ground.center ?? from, point ? 2 : 8);
    } catch (error) {
      if (error instanceof Blocked) ctx.log(`Retreat route blocked: ${error.message}`);
      else throw error;
    }
  }

  async function sweep(ctx: ProfessionContext, trip: Trip): Promise<void> {
    const points = groundPatrols(trip.ground);
    const point = points[patrol++ % points.length];
    if (!point) return;
    ctx.phase('thief-patrol', `Sweeping the ${trip.ground.name} cemetery for marks`);
    try {
      await ctx.navigate(point, 2);
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
    }
  }

  // One bounded step of a theft: break away from a chase, case a mark, close in, or take from it.
  async function work(ctx: ProfessionContext): Promise<boolean> {
    const { session } = ctx;
    const trip = state.trip;
    if (!trip) {
      state.mode = 'home';
      return false;
    }
    const status = ctx.status();
    if (Date.now() - trip.startedAt > TRIP_MS || status.hits < status.maxHits * HEALTH_FLOOR) {
      state.mode = 'back';
      return true;
    }
    const chased = [...session.world.entities.values()].find(
      (entity) => undeadMark(entity) && entity.position && distance(ctx.position(), entity.position) <= 6
    );
    // Hidden, the thief is unseen and the mark it is creeping up on is no chase.
    if (chased && !state.hidden) {
      await breakAway(ctx, chased);
      return true;
    }
    const mark = await chooseMark(ctx, markCandidates(session.world.entities.values(), ctx.position()));
    if (!mark) {
      if (++trip.sweeps > SWEEPS) {
        state.mode = 'back';
        ctx.log(`Nothing to steal in ${SWEEPS} sweeps; returning home`);
        return true;
      }
      await sweep(ctx, trip);
      return true;
    }
    return takeFrom(ctx, mark);
  }

  // Hide, sneak up, steal and break away: one bounded step against a chosen mark.
  async function takeFrom(ctx: ProfessionContext, mark: Entity): Promise<boolean> {
    const { session } = ctx;
    if (await skills.freeHands(ctx)) return true;
    if (!mark.position || distance(ctx.position(), mark.position) > 1) {
      // Preparing takes two skill windows: hide, then stealth. Moving hidden without a stealth
      // budget reveals the thief on its first step, so it waits out the shared window first.
      // Below Stealth's Hiding requirement a hide only lasts until the first step.
      if (!state.hidden && Date.now() >= state.hideRetryAt && !skills.tooUnskilledToSneak(ctx)) {
        await skills.waitForWindow(ctx);
        await skills.hide(ctx);
        return true;
      }
      if (state.hidden && !state.sneaking && Date.now() >= state.sneakRetryAt) {
        await skills.waitForWindow(ctx);
        await skills.sneak(ctx);
        return true;
      }
      await closeIn(ctx, mark);
      const approached = session.world.entities.get(mark.serial);
      if (!approached?.position || distance(ctx.position(), approached.position) > 1) return true;
    }
    const current = session.world.entities.get(mark.serial);
    if (!current?.position || distance(ctx.position(), current.position) > 1) return true;
    await skills.waitForWindow(ctx);
    ctx.phase('thief-steal', `Lifting an item from ${current.name ?? 'a mark'}`);
    await resolve(ctx, current, await skills.steal(ctx, current));
    // Leave the mark in this same turn: the runner may practise between turns, and this is no place
    // to train while a mark swings back.
    if (state.mode === 'work') await breakAway(ctx, current);
    return true;
  }

  async function resolve(ctx: ProfessionContext, mark: Entity, outcome: StealOutcome): Promise<boolean> {
    const trip = state.trip;
    if (!trip) return false;
    trip.attempts++;
    ctx.progress.attempts = (ctx.progress.attempts ?? 0) + 1;
    switch (outcome) {
      case 'stolen':
        trip.thefts++;
        ctx.progress.thefts = (ctx.progress.thefts ?? 0) + 1;
        ctx.log(`Stole from ${mark.name ?? 'a mark'}`);
        break;
      case 'failed':
      case 'heavy':
        trip.failures++;
        ctx.progress.failed = (ctx.progress.failed ?? 0) + 1;
        ctx.log(outcome === 'heavy' ? 'The mark carried nothing light enough to steal' : 'The theft failed');
        break;
      case 'empty':
        emptyMarks.add(mark.serial);
        ctx.log(`${mark.name ?? 'The mark'} carries nothing in its pack`);
        break;
      case 'refused':
        blockedMarks.add(mark.serial);
        ctx.log('That mark refuses theft; leaving it alone');
        break;
      case 'full':
        state.mode = 'back';
        ctx.log('The pack cannot hold more; returning to bank');
        break;
      case 'hands':
        ctx.log('Both hands were busy; they are free now');
        break;
      case 'far':
      case 'wait':
        break;
    }
    const status = ctx.status();
    if (
      trip.thefts >= TRIP_THEFTS ||
      trip.attempts >= TRIP_ATTEMPTS ||
      trip.failures >= TRIP_FAILURES ||
      status.weight > status.maxWeight * 0.6
    ) {
      state.mode = 'back';
    }
    return true;
  }

  return {
    // In a dungeon (dungeon-crawl.ts): steal from a lone weak creature within `radius`, none of
    // the stronger kinds close by. The town trip afterwards banks the takings as usual.
    async dungeonStep(ctx: ProfessionContext, radius: number): Promise<boolean> {
      ctx.check();
      state.mode = 'work';
      state.trip ??= {
        ground: groundFor(homeAnchor(ctx) ?? ctx.position()),
        startedAt: Date.now(),
        thefts: 0,
        attempts: 0,
        failures: 0,
        sweeps: 0
      };
      const entities = [...ctx.session.world.entities.values()];
      const marks = markCandidates(entities, ctx.position(), dungeonMark).filter(
        (mark) =>
          !!mark.position &&
          distance(ctx.position(), mark.position) <= radius &&
          !entities.some(
            (other) =>
              other.serial !== mark.serial &&
              recognised(other.graphic) &&
              !dungeonMark(other) &&
              !!other.position &&
              !!mark.position &&
              distance(other.position, mark.position) <= 8
          )
      );
      const mark = await chooseMark(ctx, marks, verifyDungeonMark);
      return mark ? takeFrom(ctx, mark) : false;
    },
    afterDungeon() {
      state.mode = 'back';
    },
    async attempt(ctx: ProfessionContext): Promise<boolean> {
      ctx.check();
      switch (state.mode) {
        case 'home':
          return await atHome(ctx);
        case 'trip':
          return await travel(ctx);
        case 'work':
          return await work(ctx);
        case 'back':
          return await returnHome(ctx);
        default:
          return false;
      }
    }
  };
}
