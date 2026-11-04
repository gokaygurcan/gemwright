import { creatures } from '@gemwright/common/game/rules';

// The ServUO creatures (common rules) as residents size them up: health, damage, combat skills,
// armor, whether they attack on sight (FightMode), their AI and the gold their loot packs carry.
export type Monster = (typeof creatures)[number];
export const monsters: readonly Monster[] = creatures;
