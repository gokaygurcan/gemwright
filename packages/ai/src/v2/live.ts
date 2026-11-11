import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

import { logger } from '../log';
import type { Terrain } from '../terrain';
import { dress } from './dress';
import { Encounter } from './encounter';
import { Hands } from './hands';
import type { Mind } from './mind';
import { describe, Narrator } from './narrate';
import { advance, liveChoices, type Places, stance } from './planning';
import { reachOver } from './reach';
import { rebirth, type Shrine } from './rebirth';

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
  // The way to far places, for weighing trips and for walking them.
  const reach = terrain && reachOver(terrain);
  if (reach) {
    mind.steps = reach.steps;
    hands.reach = reach;
  }
  // Healers and ankhs that offered nothing lately.
  const tried = new Map<string, number>();
  const refusedToWear = new Map<number, string>();
  const hovered = new Set<number>();
  const asked = new Map<number, number>();
  let spot: string | undefined;
  let last: string | undefined;
  // Woken, it looks at its skills (the client asks for them) and in its backpack: what it knows of
  // itself and carries is known only once seen.
  await session.refreshSkills();
  const backpack = [...session.world.entities.values()].find(
    (e) => e.parent === session.world.serial && e.layer === Layer.Backpack
  );
  if (backpack) {
    session.use(backpack.serial);
    await Bun.sleep(1000);
  }
  while (!stopping() && session.phase === 'ready') {
    if (narrator.listen()) {
      narrator.tell('stopped by staff');
      await Bun.sleep(1000);
      continue;
    }
    if (GHOST_BODIES.has(session.world.entities.get(session.world.serial ?? -1)?.graphic ?? 0)) {
      narrator.tell('dead; looking for a healer or an ankh');
      await rebirth(session, hands, places.shrines, (serial) => mind.call(serial), tried, stopping);
      continue;
    }
    // Wearing the best it has (its own robe back over a death robe) before anything else.
    // Its own things it has not looked at closely yet: hovered, a few a turn, as a player
    // mouses over its pack to see what each thing is (ores and ingots look alike until then).
    for (const serial of [...mind.belongings().keys()]
      .filter((serial) => {
        const item = session.world.entities.get(serial);
        return item?.kind === 'item' && !item.properties && !hovered.has(serial);
      })
      .slice(0, 3)) {
      hovered.add(serial);
      await session.inspectProperties(serial).catch((error: Error) => {
        logger('v2').info(`[v2] no hover for ${serial}: ${error.message}`);
      });
    }
    // Creatures on screen it has no name for yet (the shard answers within 18 tiles): named as a
    // player's All Names shows them, without stopping for the answer, and asked again a few seconds
    // later if none came (a cat and a hell cat share a body).
    const here = session.world.position;
    for (const entity of session.world.entities.values()) {
      const at = entity.position;
      if (entity.kind !== 'mobile' || entity.serial === session.world.serial || entity.name || !here || !at) continue;
      if (Math.max(Math.abs(at.x - here.x), Math.abs(at.y - here.y)) > 18) continue;
      if (Date.now() - (asked.get(entity.serial) ?? 0) < 5000) continue;
      asked.set(entity.serial, Date.now());
      session.requestName(entity.serial);
    }
    // A refusal while dressing is the world saying no, like any refused step: noted, never a crash.
    const dressed =
      !!terrain &&
      (await dress(session, terrain, (serial) => mind.worthOf(serial), refusedToWear).catch((error: Error) => {
        logger('v2').info(`[v2] dressing refused: ${error.message}`);
        narrator.why = `dressing refused (${error.message})`;
        return false;
      }));
    if (dressed) continue;
    const cancelled = () => stopping() || session.phase !== 'ready';
    const valued = await liveChoices(mind, session, terrain, new Set(), places, cancelled);
    if (!valued) continue;
    const best = valued[0];
    // Resting brings nothing a second; what brings no more than that is not worth getting up for.
    const resting = !best || best.rate <= -1;
    // Each time it turns to something else, what it weighed (choosing the same again is no news).
    const doing = resting ? 'rest' : best.key;
    if (doing !== last)
      record('considered', {
        doing,
        choice: doing,
        agrees: true,
        options: valued.slice(0, 5).map(({ key, value, rate }) => ({ key, value, rate }))
      });
    last = doing;
    narrator.tell(resting ? 'resting: nothing is worth doing here' : describe(best.key, best.steps));
    if (resting) {
      await hands.do(stance([]), () => !stopping());
      await hands.do({ verb: 'rest', seconds: 5 }, () => !stopping());
      continue;
    }
    // Keeping at it, unless something else is worth more by more than its patience holds it.
    await hands.do(stance(best.steps), () => !stopping());
    let remaining = best.source;
    let interrupted = false;
    let checkedRevision = mind.revision;
    const going = async () => {
      if (cancelled() || narrator.listen()) {
        interrupted = true;
        return false;
      }
      if (best.urgent) return best.steps[0]?.verb === 'escape' || !encounter.needsEscape();
      if (checkedRevision === mind.revision) return true;
      const revision = mind.revision;
      const alternatives = await liveChoices(mind, session, terrain, new Set(), places, cancelled, remaining);
      if (cancelled() || narrator.listen()) {
        interrupted = true;
        return false;
      }
      if (!alternatives) return true;
      checkedRevision = revision;
      const current = alternatives.find((o) => o.id === best.id);
      const other = alternatives[0];
      const keeping = current?.rate ?? best.rate;
      const keep = !other || other.id === best.id || other.rate - keeping <= mind.temper.patience * Math.abs(keeping);
      if (!keep) interrupted = true;
      return keep;
    };
    const heard = session.world.journal.length;
    const started = Date.now();
    let done = 0;
    for (const step of best.steps) {
      const target = step.verb === 'target' && step.x !== undefined ? `${step.x},${step.y}` : undefined;
      if (target) spot = target;
      // The client refusing a step (no cursor, nothing in view) is the world saying no, like any other.
      const did = await hands.do(step, going).catch((error: Error) => {
        logger('v2').info(`[v2] ${best.key}: ${step.verb} refused: ${error.message}`);
        narrator.why = `${describe(best.key, best.steps)}: ${step.verb} refused (${error.message})`;
        return false;
      });
      if (!did) {
        if (!interrupted && step.verb === 'drop') mind.refuseDrop(step.serial);
        break;
      }
      done++;
      remaining = advance(remaining);
    }
    // Refused at the first step, it waits a moment before choosing again rather than at once; and
    // however quickly a plan ends (already there), a client's next move takes a moment.
    await Bun.sleep(done ? 250 : 2000);
    if (spot && session.world.journal.slice(heard).some((e) => e.cliloc !== undefined && nothingLeft.has(e.cliloc))) {
      const bank = best.depletion;
      if (bank) mind.exhausted(bank);
    }
    spot = undefined;
    if (!interrupted && !stopping() && session.phase === 'ready') mind.complete(best.id, done === best.steps.length);
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
      seconds: (Date.now() - started) / 1000
    });
  }
}
