import { readFileSync } from 'node:fs';

import type { Race } from './appearance';

// Resident names by race and sex (world/names.json): humans take a given name and a surname,
// elves an elvish surname, gargoyles a single name in their own style (Draxinusom, Au'Rek), with
// an epithet once theirs is taken. ServUO allows up to 16 characters, letters, spaces and
// apostrophes in a character name (NameVerification). Picks derive from the resident id, so a
// name is stable, and never repeat one in use.
const pools = JSON.parse(readFileSync(new URL('../world/names.json', import.meta.url), 'utf8')) as Record<
  string,
  string[]
>;
const MAX = 16;
const list = (key: string) => pools[key] ?? [];

// `seed` picks where in the pool to start, `attempt` walks on from there when a name is taken.
function candidates(race: Race, female: boolean): (seed: number, attempt: number) => string | undefined {
  if (race === 'gargoyle') {
    // Every plain name is tried before any with an epithet.
    const given = list(female ? 'gargoyleFemale' : 'gargoyleMale');
    const epithets = ['', ...list('gargoyleEpithets')];
    return (seed, attempt) => {
      const name = given[(seed + attempt) % given.length];
      const epithet = epithets[Math.floor(attempt / given.length) % epithets.length];
      return name && `${name}${epithet ? ` ${epithet}` : ''}`;
    };
  }
  const given = list(race === 'elf' ? (female ? 'elfFemale' : 'elfMale') : female ? 'humanFemale' : 'humanMale');
  const family = list(race === 'elf' ? 'elfSurnames' : 'surnames');
  return (seed, attempt) => {
    // Stepping by a large prime spreads picks over the whole pool instead of neighbouring names.
    const i = (seed + attempt * 7919) % 200_000;
    const name = given[Math.floor(i / family.length) % given.length];
    const surname = family[i % family.length];
    return name && surname && `${name} ${surname}`;
  };
}

export function playerName(
  residentId: string,
  existingNames: Iterable<string>,
  look: { race: Race; female: boolean } = { race: 'human', female: false }
): string {
  const used = new Set([...existingNames].map((name) => name.toLowerCase()));
  let seed = 2166136261;
  for (const character of residentId) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const pick = candidates(look.race, look.female);
  const capacity = 200_000;
  for (let attempt = 0; attempt < capacity; attempt++) {
    const name = pick(seed, attempt);
    if (name && name.length <= MAX && !used.has(name.toLowerCase())) return name;
  }
  throw new Error('Player name pool exhausted; expand it before creating more residents');
}
