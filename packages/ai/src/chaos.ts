import { skillId } from '@gemwright/common/skills';

import type { CharacterTemplate } from './config';
import type { PlayerSession } from './protocol/session';

// How unpredictable a resident is, 0 to 1. Real players wander off their line: they go by way of
// a shop or the bank they pass, stop to greet someone, change their plans. The population's chaos
// (shard `ai.chaos`, else world.json `lifecycle.chaos`, 0.3 by default) is varied per resident by
// temperament and grows with skill progress, so a resident still building its skills stays focused.
let population = 0.3;
export const setPopulationChaos = (value: number) => {
  population = Math.max(0, Math.min(1, value));
};

const templates = new WeakMap<PlayerSession, CharacterTemplate>();
export const registerChaos = (session: PlayerSession, template: CharacterTemplate) => templates.set(session, template);

// A stable per-character factor, 0.5 to 1.5, from its serial.
const temperament = (serial: number) => 0.5 + (((serial * 2654435761) >>> 0) % 1000) / 1000;

export function chaosOf(session: PlayerSession): number {
  const template = templates.get(session);
  const serial = session.world.serial;
  if (!template || serial === null || population === 0) return 0;
  const primaries = template.archetype?.primarySkills ?? [];
  const progress = primaries.length
    ? Math.min(
        1,
        primaries.reduce((n, name) => n + (session.world.skills.get(skillId(name))?.base ?? 0), 0) /
          primaries.length /
          100
      )
    : 0.5;
  return Math.min(1, population * temperament(serial) * (0.4 + 0.6 * progress));
}
