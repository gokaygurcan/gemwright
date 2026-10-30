// The client eras a shard can run, oldest first.
export const expansions = [
  { value: 'base', label: 'Base' },
  { value: 't2a', label: 'The Second Age' },
  { value: 'uor', label: 'Renaissance' },
  { value: 'td', label: 'Third Dawn' },
  { value: 'lbr', label: "Lord Blackthorn's Revenge" },
  { value: 'aos', label: 'Age of Shadows' },
  { value: 'se', label: 'Samurai Empire' },
  { value: 'ml', label: "Mondain's Legacy" },
  { value: 'sa', label: 'Stygian Abyss' },
  { value: 'hs', label: 'High Seas' },
  { value: 'tol', label: 'Time of Legends' },
  { value: 'ej', label: 'Endless Journey' }
] as const;

export type Expansion = (typeof expansions)[number]['value'];

// ServUO's Expansion enum names (Config/Expansion.cfg CurrentExpansion), by era.
export const expansionNames: Record<Expansion, string> = {
  base: 'None',
  t2a: 'T2A',
  uor: 'UOR',
  td: 'UOTD',
  lbr: 'LBR',
  aos: 'AOS',
  se: 'SE',
  ml: 'ML',
  sa: 'SA',
  hs: 'HS',
  tol: 'TOL',
  ej: 'EJ'
};
