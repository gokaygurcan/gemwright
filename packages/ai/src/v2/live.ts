import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import { logger } from '../log';
import type { Terrain } from '../terrain';
import { journey } from './atlas';
import { byWay } from './banking';
import { shedding } from './burden';
import { dress, shed } from './dress';
import { type Answer, Encounter } from './encounter';
import { keepStatLocks } from './growth';
import { Hands } from './hands';
import { hover } from './hover';
import { LoopBreaker, planBudget } from './loop-breaker';
import type { Mind } from './mind';
import { describe, Narrator } from './narrate';
import { screenOf } from './perceive';
import { advance, digest, liveChoices, type Places, stance, weighed } from './planning';
import { reachOver } from './reach';
import { rebirth, type Shrine } from './rebirth';
import { shower } from './show';

// What tells it a spot has nothing left to harvest (ServUO Mining, Lumberjacking, Fishing
// NoResourcesMessage), and how long until a spot's resources grow back at the latest (their
// HarvestDefinition MaxRespawn).
const nothingLeft = new Set([503040, 500493, 503172]);
// A decision taking this long holds every resident up (they share one thread): worth a log line.
const SLOW_DECISION_MS = 500;

// Living by its own choices: what it could do, each valued by what it expects of it, the best done
// with its hands, step by step, until done or until something else is worth more than keeping at
// it by more than its patience allows. Dead, it seeks a healer.
export async function live(
  session: PlayerSession,
  mind: Mind,
  terrain: Terrain | undefined,
  places: {
    shrines: readonly Shrine[];
    bankers: readonly { x: number; y: number }[];
    vendors: readonly { x: number; y: number; range?: number; types: string[] }[];
    forges?: Places['forges'];
  },
  stopping: () => boolean,
  record: (kind: string, data: object, via?: 'noticed') => void,
  // The id of the newest event in its history: where each decision's trace begins.
  mark: () => number = () => 0
) {
  const screen = screenOf(session);
  const narrator = new Narrator(session, record);
  const encounter = new Encounter(session, mind, terrain, () => stopping() || narrator.listen());
  mind.encounter = encounter;
  // The banks stand in guarded towns: where it runs when running costs less than fighting.
  encounter.havens = places.bankers;
  const hands = new Hands(
    session,
    terrain,
    () => mind.mount,
    (serial) => mind.call(serial),
    (serial) => mind.worthOf(serial),
    mind.locomotion,
    () => !stopping() && session.phase === 'ready' && !narrator.listen(),
    encounter
  );
  hands.canReach = (goal) => mind.reachable(goal);
  hands.notice = (kind, data) => mind.notice(kind, data);
  // A way the land closes stays closed for hours; one only the creatures about close, for the minute
  // they take to move on.
  hands.blocked = (from, goal, hemmed) => {
    mind.notice('route-failed', {
      from,
      goal,
      until: Date.now() + (hemmed ? 60_000 : encounter.needsEscape() ? 10 * 60_000 : 2 * 3_600_000)
    });
    if (!hemmed) mind.notice('stranded', { from, goal });
  };
  // The way to far places, for weighing trips and for walking them.
  const reach = terrain && reachOver(terrain);
  if (reach) {
    mind.steps = reach.steps;
    hands.reach = reach;
  }
  hands.missing = (serial, where) => {
    const data = { serial, where };
    record('missing', data, 'noticed');
    mind.observe({ resident: '', at: Date.now(), kind: 'missing', data });
  };
  // Healers and ankhs that offered nothing lately.
  const tried = new Map<string, number>();
  const hovered = new Set<number>();
  const asked = new Map<number, number>();
  let spot: string | undefined;
  // The plan it last broke off for something better: not taken back while that something lasts, so
  // two plans cannot trade places back and forth.
  let left: string | undefined;
  const breaker = new LoopBreaker();
  const visited = new Map<string, number>();
  let searches = 0;
  let progress = mind.progress;
  const cancelled = () => stopping() || session.phase !== 'ready' || narrator.listen();
  // A weighing, traced so it can be simulated again (simulate.ts): where in its history it began,
  // how far it had come each time it let the session run (and what had happened by then), and every
  // answer the encounter gave it.
  const think = async (active?: Parameters<typeof liveChoices>[5]) => {
    const tape: Answer[] = [];
    const trace = { from: mark(), now: Date.now(), slices: [] as [number, number, number][], tape, active };
    encounter.tapes.add(tape);
    const thinking = performance.now();
    // Thinking long enough to be seen standing still, it shows it is thinking.
    const pondering = setTimeout(() => narrator.tell('thinking it over'), 1000);
    try {
      const valued = await liveChoices(mind, terrain, new Set(), places, cancelled, active, false, (steps, at) =>
        trace.slices.push([steps, mark(), at])
      );
      return {
        valued,
        ms: Math.round(performance.now() - thinking),
        trace: { ...trace, digest: digest(valued), weighed: weighed(valued) }
      };
    } finally {
      clearTimeout(pondering);
      encounter.tapes.delete(tape);
    }
  };
  const relocate = async (reason: string) => {
    const here = screen.position;
    if (cancelled()) return;
    // Not knowing where it stands, it asks the shard, as a client resyncs.
    if (!here) return void (await session.resyncPosition());
    for (const [key, at] of visited) if (Date.now() - at >= 300_000) visited.delete(key);
    record('loop-broken', { reason, position: here });
    logger('v2').info(`[v2] changing course: ${reason}`);
    narrator.tell('looking for different work');
    const distance = (point: { x: number; y: number }) =>
      Math.max(Math.abs(point.x - here.x), Math.abs(point.y - here.y));
    const destinations = [
      ...places.bankers,
      ...places.vendors,
      ...[
        [24, 0],
        [0, 24],
        [-24, 0],
        [0, -24],
        [24, 24],
        [-24, -24]
      ].map(([x, y]) => ({ x: here.x + (x ?? 0), y: here.y + (y ?? 0) }))
    ]
      .filter((point) => point.x >= 0 && point.y >= 0 && distance(point) > 18 && mind.allowed(point))
      .sort(
        (a, b) => (visited.get(`${a.x},${a.y}`) ?? 0) - (visited.get(`${b.x},${b.y}`) ?? 0) || distance(a) - distance(b)
      );
    const seen = new Set<string>();
    for (const destination of destinations) {
      const key = `${destination.x},${destination.y}`;
      if (seen.has(key)) continue;
      if (seen.size >= 8 || cancelled() || encounter.needsEscape()) break;
      seen.add(key);
      visited.set(key, Date.now());
      const until = Date.now() + 30_000;
      const going = () => !cancelled() && !encounter.needsEscape() && Date.now() < until;
      const refused = (error: Error) => {
        narrator.why = `walking to ${key} refused (${error.message})`;
        return false;
      };
      await hands.do(stance([]), going).catch(refused);
      const moved = await hands.do({ verb: 'walk', ...destination, range: 2 }, going).catch(refused);
      const now = screen.position;
      record('course-changed', { destination, reached: moved, position: now });
      if (moved && now && Math.max(Math.abs(now.x - here.x), Math.abs(now.y - here.y)) > 2) {
        breaker.relocated();
        searches = 0;
        return;
      }
    }
    if (!cancelled() && !encounter.needsEscape()) {
      if (mind.care.needsHelp() && (await hands.do({ verb: 'help' }, () => !cancelled()).catch(() => false))) {
        breaker.relocated();
        return;
      }
      // Every way it tried refused it: it says so and thinks again from where it stands; the places
      // it tried wait five minutes before it tries them again.
      record('loop-blocked', { reason: 'No alternative destination reachable', attempted: seen.size });
      narrator.why = `no way to any of ${seen.size} places it tried`;
    }
  };
  // Woken, it looks at its skills (the client asks for them) and in its backpack: what it knows of
  // itself and carries is known only once seen.
  narrator.tell('waking up: looking at my skills and status');
  await session.refreshSkills();
  if (session.refreshStatus) await session.refreshStatus();
  const backpack = [...screen.entities.values()].find((e) => e.parent === screen.serial && e.layer === Layer.Backpack);
  // What it wears shows at once: a death robe among it goes to the floor before the pack is opened.
  await shed(
    session,
    mind,
    stopping,
    (serial) => hands.missing?.(serial, 'pack'),
    (doing) => narrator.tell(doing)
  );
  if (backpack) {
    narrator.tell('looking in my backpack');
    session.use(backpack.serial);
    await Bun.sleep(1000);
    // And every bag in it, bags in bags too: what it carries is known whole from the start.
    const opened = new Set([backpack.serial]);
    for (let bag = nextBag(); bag !== undefined && !stopping(); bag = nextBag()) {
      opened.add(bag);
      session.use(bag);
      await Bun.sleep(600);
    }
    function nextBag() {
      return mind
        .has()
        .pack.find(
          (item) =>
            item.kind === 'container' &&
            !opened.has(item.serial) &&
            opened.has(screen.entities.get(item.serial)?.parent ?? -1)
        )?.serial;
    }
  }
  // While its hands are at a plan, nothing else touches the world through them.
  let busy = false;
  void hover(session, mind, stopping, hovered, () => busy);
  const showing = shower(mind, narrator, record);
  const locksSent: (number | undefined)[] = [];
  let facet = screen.map;
  while (!stopping() && session.phase === 'ready') {
    // Moved to another map: where it stands there, as the shard has it.
    if (screen.map !== facet) {
      facet = screen.map;
      await session.resyncPosition();
    }
    if (narrator.listen()) {
      narrator.tell('stopped by staff');
      await Bun.sleep(1000);
      continue;
    }
    if (GHOST_BODIES.has(screen.entities.get(screen.serial ?? -1)?.graphic ?? 0)) {
      if (mind.care.needsHelp() && (await hands.do({ verb: 'help' }, () => !cancelled()).catch(() => false))) continue;
      narrator.tell('dead; looking for a healer or an ankh');
      const unanswered = await rebirth(
        session,
        hands,
        places.shrines,
        (serial) => mind.call(serial),
        tried,
        stopping,
        mind.steps
      ).catch((error: Error) => `seeking resurrection refused (${error.message})`);
      if (unanswered) narrator.why = unanswered;
      continue;
    }
    // Raised, or woken carrying one: every death robe goes to the floor before anything else.
    if (
      !(await shed(
        session,
        mind,
        stopping,
        (serial) => hands.missing?.(serial, 'pack'),
        (doing) => narrator.tell(doing)
      ))
    )
      continue;
    // Outside the cities it is kept to (gemwright.json ai.cities), it goes back first: to the nearest
    // banker there by the way, and nothing else until it stands within them.
    const standing = screen.position;
    if (standing && !mind.allowed(standing)) {
      // The nearest banker by the way there, or the nearest at all when no way is known.
      const home =
        byWay(mind.steps, standing, screen.map, places.bankers)[0] ??
        byWay(undefined, standing, screen.map, places.bankers)[0];
      narrator.tell('going back where it belongs');
      record('returning', { from: standing, to: home ?? null });
      const back =
        home &&
        (await hands
          .do({ verb: 'walk', x: home.x, y: home.y, range: 3 }, () => !cancelled())
          .catch((error: Error) => {
            narrator.why = `going back refused (${error.message})`;
            return false;
          }));
      if (!back) await relocate('No way back to where it belongs');
      continue;
    }
    if (
      breaker.stalled() &&
      !encounter.response() &&
      !(mind.self.weight && mind.self.weight.current > mind.self.weight.max)
    ) {
      await relocate('No useful progress within the attempt or time budget');
      continue;
    }
    // Wearing the best it has (its own robe back over a death robe) before anything else.
    keepStatLocks(mind, session, locksSent, record);
    showing();
    // Creatures on screen it has no name for yet (the shard answers within 18 tiles): named as a
    // player's All Names shows them, without stopping for the answer, and asked again a few seconds
    // later if none came (a cat and a hell cat share a body).
    const here = screen.position;
    for (const entity of screen.entities.values()) {
      const at = entity.position;
      if (entity.kind !== 'mobile' || entity.serial === screen.serial || entity.name || !here || !at) continue;
      if (Math.max(Math.abs(at.x - here.x), Math.abs(at.y - here.y)) > 18) continue;
      if (Date.now() - (asked.get(entity.serial) ?? 0) < 5000) continue;
      asked.set(entity.serial, Date.now());
      session.requestName(entity.serial);
    }
    // A refusal while dressing is the world saying no, like any refused step: noted, never a crash.
    const dressed = await dress(session, mind, terrain).catch((error: Error) => {
      logger('v2').info(`[v2] dressing refused: ${error.message}`);
      narrator.why = `dressing refused (${error.message})`;
      return false;
    });
    if (dressed) {
      breaker.finish('dressing', true, false);
      continue;
    }
    const trigger = mind.changedBy;
    const { valued, ms, trace } = await think();
    if (ms >= SLOW_DECISION_MS) logger('v2').info(`[v2] slow decision: ${ms} ms after ${trigger || 'start'}`);
    if (!valued) {
      if (++searches >= 3) await relocate('Deliberation repeatedly invalidated before choosing work');
      continue;
    }
    searches = 0;
    const best = valued.find((option) => breaker.allows(option.id));
    const changing = !best || (!best.urgent && best.rate <= -1);
    const doing = changing ? 'change course' : best.key;
    record('considered', {
      ms,
      trigger,
      trace,
      doing,
      choice: doing,
      agrees: true,
      id: best?.id,
      steps: best?.steps,
      value: best?.value,
      rate: best?.rate,
      seconds: best?.seconds,
      urgent: best?.urgent ?? false,
      funding: best?.funding,
      guarded: mind.guarded,
      traits: { ...mind.temper },
      options: valued.slice(0, 5).map(({ id, key, value, rate, seconds }) => ({
        id,
        key,
        value,
        rate,
        seconds,
        blocked: !breaker.allows(id)
      }))
    });
    if (changing || !best) {
      // Over its limit: the least it can put down to move freely again.
      const shed = shedding(mind);
      if (shed) {
        narrator.tell(`putting down ${shed.amount} ${mind.call(shed.serial) ?? 'things'} to carry less`);
        const dropped = await hands
          .do({ verb: 'drop', ...shed }, () => !cancelled())
          .catch((error: Error) => {
            narrator.why = `putting down to carry less refused (${error.message})`;
            return false;
          });
        if (!dropped) mind.refuseDrop(shed.serial);
        continue;
      }
      // In danger with no way out it is taking: it turns on the nearest of those fighting it.
      const foe = encounter.needsEscape() ? encounter.attacker() : undefined;
      if (foe !== undefined) {
        narrator.tell(`fighting back ${mind.call(foe)?.split('/')[0] ?? 'an attacker'}`);
        await hands
          .do({ verb: 'fight', serial: foe, back: true }, () => !cancelled())
          .catch((error: Error) => {
            narrator.why = `fighting back refused (${error.message})`;
            return false;
          });
        continue;
      }
      await relocate('No worthwhile unblocked work at the current location');
      continue;
    }
    const at = screen.position;
    const atlas = mind.atlas;
    const bound =
      at && atlas && reach
        ? journey(best.steps, { ...at, map: screen.map }, mind.here, (p) => atlas.at(p), reach)
        : undefined;
    if (bound) record('bound', { id: best.id, ...bound });
    narrator.tell(bound ? `${describe(best.key, best.steps)} (${bound.to})` : describe(best.key, best.steps));
    // Keeping at it, unless something else is worth more by more than its patience holds it.
    await hands
      .do(stance(best.steps), () => !stopping())
      .catch((error: Error) => {
        narrator.why = `${describe(best.key, best.steps)}: getting ready refused (${error.message})`;
        return false;
      });
    let remaining = best.source;
    let interrupted = false;
    let interruption: object | undefined;
    let checkedNoticed = mind.noticed;
    let reconsidering = false;
    // Weighed again while it keeps moving, as a player thinks on the way: the step never waits for
    // it, and a better choice stops the plan at the next step.
    const reconsider = async () => {
      reconsidering = true;
      const noticed = mind.noticed;
      const trigger = mind.changedBy;
      const { valued: alternatives, ms, trace } = await think(remaining);
      reconsidering = false;
      if (!alternatives || interrupted) return;
      checkedNoticed = noticed;
      const current = alternatives.find((o) => o.id === best.id);
      const other = alternatives.find((option) => breaker.allows(option.id) && option.id !== left);
      const keeping = current?.rate ?? best.rate;
      // Better by more than its patience holds it, measured against the larger of the two, so two
      // near-even plans never flip on the noise of their estimates.
      const keep =
        !other ||
        other.id === best.id ||
        other.rate - keeping <= mind.temper.patience * Math.max(Math.abs(keeping), Math.abs(other.rate));
      // Every second thought on the way, kept or not: what woke it, what it cost, what it weighed.
      record('reconsidered', {
        id: best.id,
        ms,
        trigger,
        trace,
        kept: keep,
        keeping,
        alternative: other && { id: other.id, key: other.key, rate: other.rate }
      });
      if (ms >= SLOW_DECISION_MS) logger('v2').info(`[v2] slow reconsideration: ${ms} ms after ${trigger}`);
      if (keep) return;
      interrupted = true;
      interruption = {
        reason: 'better opportunity',
        keeping,
        patience: mind.temper.patience,
        alternative: { id: other.id, key: other.key, rate: other.rate }
      };
    };
    const going = async () => {
      const cancelledNow = cancelled();
      if (cancelledNow || Date.now() - started >= budget) {
        interrupted = true;
        interruption = { reason: cancelledNow ? 'session or staff cancellation' : 'plan time budget' };
        return false;
      }
      if (interrupted) return false;
      if (best.urgent) return best.steps[0]?.verb === 'escape' || !encounter.needsEscape();
      if (checkedNoticed !== mind.noticed && !reconsidering) void reconsider();
      return true;
    };
    const heard = screen.heard;
    const started = Date.now();
    // As long as it expects the plan to take (the walk there included), stretched by its patience;
    // never under a minute.
    const budget = planBudget(best.seconds, mind.temper.patience);
    breaker.started(budget);
    const health = screen.status?.hits;
    const poison = screen.poisonLevel;
    let done = 0;
    let refusal: object | undefined;
    busy = true;
    for (const step of best.steps) {
      const target = step.verb === 'target' && step.x !== undefined ? `${step.x},${step.y}` : undefined;
      if (target) spot = target;
      // The client refusing a step (no cursor, nothing in view) is the world saying no, like any other.
      const did = await hands.do(step, going).catch((error: Error) => {
        logger('v2').info(`[v2] ${best.key}: ${step.verb} refused: ${error.message}`);
        narrator.why = `${describe(best.key, best.steps)}: ${step.verb} refused (${error.message})`;
        refusal = { step: done, verb: step.verb, error: error.message };
        return false;
      });
      if (!did) {
        if (!interrupted) refusal ??= { step: done, verb: step.verb };
        if (!interrupted && step.verb === 'drop') mind.refuseDrop(step.serial);
        break;
      }
      done++;
      remaining = advance(remaining);
    }
    // Refused at the first step, it waits a moment before choosing again rather than at once; and
    // however quickly a plan ends (already there), a client's next move takes a moment.
    busy = false;
    await Bun.sleep(done ? 250 : 2000);
    if (spot && screen.journalSince(heard).some((e) => e.cliloc !== undefined && nothingLeft.has(e.cliloc))) {
      const bank = best.depletion;
      if (bank) mind.exhausted(bank);
    }
    spot = undefined;
    if (!interrupted && !stopping() && session.phase === 'ready') mind.complete(best.id, done === best.steps.length);
    const advanced =
      mind.progress > progress ||
      (!!best.urgent &&
        ((health !== undefined && (screen.status?.hits ?? health) > health) ||
          ((poison ?? 0) > 0 && screen.poisonLevel === 0)));
    progress = mind.progress;
    // A plan it abandoned of its own accord — a walk broken off to take something better — is an
    // unrealized experience: nothing counts against it, and nothing against the chances of the place
    // it was going to.
    if (!interrupted) breaker.finish(best.id, done === best.steps.length, advanced);
    left = interrupted && interruption && 'alternative' in interruption ? best.id : undefined;
    if (!breaker.allows(best.id))
      record('loop-broken', { reason: 'Repeated unsuccessful or unproductive plan', id: best.id });
    record('plan-ended', {
      id: best.id,
      key: best.key,
      result:
        stopping() || session.phase !== 'ready'
          ? 'cancelled'
          : interrupted
            ? 'interrupted'
            : done === best.steps.length
              ? 'completed'
              : 'refused',
      done,
      total: best.steps.length,
      advanced,
      interruption,
      refusal,
      seconds: (Date.now() - started) / 1000
    });
  }
}
