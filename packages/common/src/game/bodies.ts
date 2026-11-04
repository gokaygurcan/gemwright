import { bodiesOf, races } from './rules';

// Character bodies as the client sees them, from the ServUO rules (rules.ts: RaceDefinitions.cs and
// the mobiles' own bodies). Several modules tell players and residents from creatures, and the
// living from ghosts, by body.
const race = (name: string) => {
  const found = races.find((r) => r.name === name);
  if (!found) throw new Error(`ServUO rules have no race ${name}`);
  return found;
};
const living = (...names: string[]) => new Set(names.flatMap((name) => [race(name).male, race(name).female]));

// Living human, elf and gargoyle bodies.
export const HUMAN_BODIES = living('Human', 'Elf', 'Gargoyle');
// Gargoyle bodies: they fly instead of riding, and wear only gargish gear.
export const GARGOYLE_BODIES = living('Gargoyle');
// Human and elf bodies only (gargoyles cannot mount, wear human clothing or be begged from).
export const HUMAN_ELF_BODIES = living('Human', 'Elf');
// Plain human bodies, the shape of NPC townsfolk and vendors.
export const PLAIN_HUMAN_BODIES = living('Human');
// A dead character's ghost.
export const GHOST_BODIES = new Set(races.flatMap((r) => [r.maleGhost, r.femaleGhost]));
// Rideable horses (every body a Horse takes).
export const HORSE_BODIES = new Set(bodiesOf('Horse'));
// Pack horses and pack llamas.
export const PACK_ANIMAL_BODIES = new Set([...bodiesOf('PackHorse'), ...bodiesOf('PackLlama')]);
