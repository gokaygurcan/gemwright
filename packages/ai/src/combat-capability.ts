import { skillId } from '@gemwright/common/skills';
import { Layer } from '@gemwright/network/layers';
import type { PlayerSession } from '@gemwright/network/session';

export interface CombatCapability {
  skills: Record<string, number>;
  armor: number;
  maxHits: number;
  weapons: number[];
}
export function combatCapability(session: PlayerSession): CombatCapability {
  return {
    skills: Object.fromEntries([...session.world.skills].map(([id, skill]) => [id, skill.value])),
    armor: session.world.status?.armor ?? 0,
    maxHits: session.world.status?.maxHits ?? 0,
    weapons: session.world
      .childrenOf(session.world.serial ?? -1)
      .filter((item) => item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded)
      .map((item) => item.graphic)
      .sort((a, b) => a - b)
  };
}
export function comparableCapability(before: CombatCapability | undefined, current: CombatCapability | undefined) {
  if (!before || !current) return 1;
  // Only combat-relevant skill changes alter combat evidence; crafting gains do not.
  const relevant = [
    'Anatomy',
    'Parry',
    'EvalInt',
    'Healing',
    'Magery',
    'MagicResist',
    'Tactics',
    'Archery',
    'SpiritSpeak',
    'Swordsmanship',
    'Macing',
    'Fencing',
    'Wrestling',
    'Meditation',
    'Necromancy',
    'Focus',
    'Chivalry',
    'Bushido',
    'Ninjitsu',
    'Spellweaving',
    'Mysticism'
  ].map(skillId);
  const changedSkills = Math.max(
    0,
    ...relevant.map((id) => Math.max(0, (current.skills[id] ?? 0) - (before.skills[id] ?? 0)))
  );
  const difference =
    changedSkills / 20 +
    Math.max(0, current.armor - before.armor) / 25 +
    Math.max(0, current.maxHits - before.maxHits) / 30 +
    (JSON.stringify(before.weapons) === JSON.stringify(current.weapons) ? 0 : 1);
  return 1 / (1 + difference);
}
