import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import { logger } from '../log';
import type { Terrain } from '../terrain';
import { journey } from './atlas';
import { byWay } from './banking';
import { dress, shed } from './dress';
import { Encounter } from './encounter';
import { keepStatLocks } from './growth';
import { Hands } from './hands';
import { hover } from './hover';
import { LoopBreaker, planBudget } from './loop-breaker';
import type { Mind } from './mind';
import { describe, Narrator } from './narrate';
import { screenOf } from './perceive';
import { advance, liveChoices, type Places, stance } from './planning';
import { reachOver } from './reach';
import { rebirth, type Shrine } from './rebirth';
import { shower } from './show';

// What tells it a spot has nothing left to harvest (ServUO Mining, Lumberjacking, Fishing
// NoResourcesMessage), and how long until a spot's resources grow back at the latest (their
// HarvestDefinition MaxRespawn).
const nothingLeft = new Set([503040, 500493, 503172]);

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
  record: (kind: string, data: object) => void
) {
  const screen = screenOf(session);
  const narrator = new Narrator(session);
  const encounter = new Encounter(session, mind, terrain, () => stopping() || narrator.listen());
  mind.encounter = encounter;
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
  hands.blocked = (from, goal) => {
    mind.notice('route-failed', {
      from,
      goal,
      until: Date.now() + (encounter.needsEscape() ? 10 * 60_000 : 2 * 3_600_000)
    });
    mind.notice('stranded', { from, goal });
  };
  // The way to far places, for weighing trips and for walking them.
  const reach = terrain && reachOver(terrain);
  if (reach) {
    mind.steps = reach.steps;
    hands.reach = reach;
  }
  hands.missing = (serial, where) => {
    const data = { serial, where };
    record('missing', data);
    mind.observe({ resident: '', at: Date.now(), kind: 'missing', data });
  };
  // Healers and ankhs that offered nothing lately.
  const tried = new Map<string, number>();
  const refusedToWear = new Map<number, string>();
  const hovered = new Set<number>();
  const asked = new Map<number, number>();
  let spot: string | undefined;
  const breaker = new LoopBreaker();
  const visited = new Map<string, number>();
  let searches = 0;
  let progress = mind.progress;
  const cancelled = () => stopping() || session.phase !== 'ready' || narrator.listen();
  const relocate = async (reason: string) => {
    const here = screen.position;
    if (cancelled()) return;
    if (!here) {
      record('loop-blocked', { reason: 'Player position unavailable' });
      throw new Error('Resident cannot change course: player position unavailable');
    }
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
      await hands.do(stance([]), going);
      const moved = await hands.do({ verb: 'walk', ...destination, range: 2 }, going);
      const now = screen.position;
      record('course-changed', { destination, reached: moved, position: now });
      if (moved && now && Math.max(Math.abs(now.x - here.x), Math.abs(now.y - here.y)) > 2) {
        breaker.relocated();
        searches = 0;
        return;
      }
    }
    if (!cancelled() && !encounter.needsEscape()) {
      if (mind.care.needsHelp() && (await hands.do({ verb: 'help' }, () => !cancelled()))) {
        breaker.relocated();
        return;
      }
      record('loop-blocked', { reason: 'No alternative destination reachable', attempted: seen.size });
      throw new Error('Resident cannot change course: no alternative destination reachable');
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
      if (mind.care.needsHelp() && (await hands.do({ verb: 'help' }, () => !cancelled()))) continue;
      narrator.tell('dead; looking for a healer or an ankh');
      await rebirth(session, hands, places.shrines, (serial) => mind.call(serial), tried, stopping, mind.steps);
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
      const home = byWay(mind.steps, standing, screen.map, places.bankers)[0];
      narrator.tell('going back where it belongs');
      record('returning', { from: standing, to: home ?? null });
      if (!home || !(await hands.do({ verb: 'walk', x: home.x, y: home.y, range: 3 }, () => !cancelled())))
        await Bun.sleep(2000);
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
    const dressed = await dress(session, mind, terrain, refusedToWear).catch((error: Error) => {
      logger('v2').info(`[v2] dressing refused: ${error.message}`);
      narrator.why = `dressing refused (${error.message})`;
      return false;
    });
    if (dressed) {
      breaker.finish('dressing', true, false);
      continue;
    }
    const valued = await liveChoices(mind, terrain, new Set(), places, cancelled, undefined, false);
    if (!valued) {
      if (++searches >= 3) await relocate('Deliberation repeatedly invalidated before choosing work');
      continue;
    }
    searches = 0;
    const best = valued.find((option) => breaker.allows(option.id));
    const changing = !best || (!best.urgent && best.rate <= -1);
    const doing = changing ? 'change course' : best.key;
    record('considered', {
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
      if (mind.self.weight && mind.self.weight.current > mind.self.weight.max) {
        record('loop-blocked', { reason: 'No successful overload recovery available' });
        throw new Error('Resident cannot travel: overload recovery exhausted');
      }
      if (encounter.needsEscape()) {
        record('loop-blocked', { reason: 'Safety response exhausted its attempt budget' });
        throw new Error('Resident cannot change course: safety response exhausted its attempt budget');
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
    await hands.do(stance(best.steps), () => !stopping());
    let remaining = best.source;
    let interrupted = false;
    let interruption: object | undefined;
    let checkedRevision = mind.revision;
    let reconsidering = false;
    // Weighed again while it keeps moving, as a player thinks on the way: the step never waits for
    // it, and a better choice stops the plan at the next step.
    const reconsider = async () => {
      reconsidering = true;
      const revision = mind.revision;
      const alternatives = await liveChoices(mind, terrain, new Set(), places, cancelled, remaining, false);
      reconsidering = false;
      if (!alternatives || interrupted) return;
      checkedRevision = revision;
      const current = alternatives.find((o) => o.id === best.id);
      const other = alternatives.find((option) => breaker.allows(option.id));
      const keeping = current?.rate ?? best.rate;
      if (!other || other.id === best.id || other.rate - keeping <= mind.temper.patience * Math.abs(keeping)) return;
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
      if (checkedRevision !== mind.revision && !reconsidering) void reconsider();
      return true;
    };
    const heard = screen.journal.length;
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
    if (spot && screen.journal.slice(heard).some((e) => e.cliloc !== undefined && nothingLeft.has(e.cliloc))) {
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
