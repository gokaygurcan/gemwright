// Character bodies as the client sees them (ServUO Body.cs, Race.cs). Several modules tell players
// and residents from creatures, and the living from ghosts, by body.

// Living human, elf and gargoyle bodies.
export const HUMAN_BODIES = new Set([
  0x190, // human male
  0x191, // human female
  0x25d, // elf male
  0x25e, // elf female
  0x29a, // gargoyle male
  0x29b // gargoyle female
]);

// Gargoyle bodies: they fly instead of riding, and wear only gargish gear.
export const GARGOYLE_BODIES = new Set([
  0x29a, // gargoyle male
  0x29b // gargoyle female
]);

// Human and elf bodies only (gargoyles cannot mount, wear human clothing or be begged from).
export const HUMAN_ELF_BODIES = new Set([
  0x190, // human male
  0x191, // human female
  0x25d, // elf male
  0x25e // elf female
]);

// Plain human bodies, the shape of NPC townsfolk and vendors.
export const PLAIN_HUMAN_BODIES = new Set([
  0x190, // human male
  0x191 // human female
]);

// A dead character's ghost.
export const GHOST_BODIES = new Set([
  0x192, // human male ghost
  0x193, // human female ghost
  0x25f, // elf male ghost
  0x260, // elf female ghost
  0x2b6, // gargoyle female ghost
  0x2b7 // gargoyle male ghost
]);
