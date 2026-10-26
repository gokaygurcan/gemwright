import { skillId } from '@gemwright/common/skills';

import { observedWorkCount } from './activity';
import type { CharacterTemplate } from './config';
import type { PlayerSession } from './protocol/session';
import { personalMemory } from './resident-memory';
import type { Checkpoint } from './store';

interface Observation {
  at: number;
  map: number;
  x: number;
  y: number;
  activity: string;
  skills: number;
  products: number;
}
const observations = new WeakMap<PlayerSession, Observation>();
export function learnWork(
  session: PlayerSession,
  checkpoint: Checkpoint,
  template: CharacterTemplate,
  now = Date.now()
) {
  const point = session.world.position;
  if (!point || session.world.map === null) return;
  const skills = (template.archetype?.primarySkills ?? []).reduce(
    (n, name) => n + (session.world.skills.get(skillId(name))?.base ?? 0),
    0
  );
  const products = observedWorkCount(session);
  const previous = observations.get(session);
  const activity = checkpoint.goal?.phase ?? 'unknown';
  if (
    previous &&
    now - previous.at < 1000 &&
    previous.activity === activity &&
    previous.products === products &&
    previous.skills === skills
  )
    return;
  observations.set(session, { at: now, map: session.world.map, ...point, activity, skills, products });
  if (!previous || now - previous.at < 0 || now - previous.at > 15 * 60_000) return;
  if (!/mining|chopp|fishing|training|fighting|gathering|smelt/.test(previous.activity)) return;
  const memory = personalMemory(checkpoint, now);
  const x = (previous.x >> 5) << 5,
    y = (previous.y >> 5) << 5;
  let place = memory.strategies.find(
    (entry) => entry.map === previous.map && entry.x === x && entry.y === y && entry.activity === previous.activity
  );
  if (!place) {
    place = {
      map: previous.map,
      x,
      y,
      activity: previous.activity,
      attempts: 0,
      productive: 0,
      setbacks: 0,
      skillGain: 0,
      updatedAt: now
    };
    memory.strategies.push(place);
  }
  place.attempts++;
  const gain = Math.max(0, skills - previous.skills);
  const product = products > previous.products && session.world.map === previous.map;
  if (gain > 0 || product) place.productive++;
  if (/setback|blocked|escaping|death/.test(activity)) place.setbacks++;
  place.skillGain += gain;
  place.updatedAt = now;
  if (place.productive >= 3 && place.productive > place.setbacks * 2)
    memory.favorite = { map: place.map, x: place.x, y: place.y, activity: place.activity };
}

// Sparse or old evidence has little influence and can never bypass a safety/readiness check.
export function learnedPlaceCost(
  checkpoint: Checkpoint | undefined,
  map: number,
  point: { x: number; y: number },
  now = Date.now()
): number {
  return (checkpoint?.personal?.strategies ?? [])
    .filter(
      (place) =>
        place.map === map &&
        Math.max(Math.abs(place.x - point.x), Math.abs(place.y - point.y)) <= 96 &&
        place.attempts >= 3
    )
    .reduce(
      (cost, place) =>
        cost +
        Math.max(0, 1 - (now - place.updatedAt) / (7 * 86400_000)) *
          Math.max(
            -100,
            Math.min(
              150,
              (place.setbacks * 40 - place.productive * 15 - place.skillGain * 20) / Math.sqrt(place.attempts)
            )
          ),
      0
    );
}
