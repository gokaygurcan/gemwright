import type { Monster } from './monster-reference';

const casters = new Set(['Mage', 'NecroMage', 'Spellbinder', 'Spellweaving', 'Mystic', 'Necro']);
export const castsSpells = (stats: Monster) => casters.has(stats.ai ?? '') || stats.magery > 0;
