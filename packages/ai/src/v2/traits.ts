// Who the resident is: its core traits and its leaning to each virtue (and to Chaos), each from 0
// to 1, drawn once at birth and kept in its history.
export const traitNames = [
  'boldness',
  'greed',
  'patience',
  'sociability',
  'curiosity',
  'diligence',
  'compassion',
  'honesty',
  'honor',
  'humility',
  'justice',
  'sacrifice',
  'spirituality',
  'valor',
  'chaos'
] as const;
export type Traits = Record<(typeof traitNames)[number], number>;

// Its traits as born (the history's `born` event), or new ones to record when it has none yet.
export function traitsOf(born: object[], draw = Math.random): { traits: Traits; drawn: boolean } {
  const kept = (born.at(-1) as { traits?: Traits } | undefined)?.traits;
  if (kept) return { traits: kept, drawn: false };
  return {
    traits: Object.fromEntries(traitNames.map((name) => [name, Math.round(draw() * 1000) / 1000])) as Traits,
    drawn: true
  };
}
