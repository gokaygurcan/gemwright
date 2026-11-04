import { races } from '@gemwright/common/game/rules';
import type { Appearance } from '@gemwright/network/appearance';

export type { Appearance } from '@gemwright/network/appearance';

// What a new character looks like: sex, race, skin, hair, beard and the colours of its starting
// shirt and pants, chosen at the creation screen like any player would. Values derive from the
// resident id (as temperament does), so they are stable, and stay within ServUO's race rules
// (Scripts/Misc/RaceDefinitions.cs): about half are women, races come from gemwright.json
// (`ai.races`), shirt and pants take dyeable hues (CharacterCreation ClipDyedHue, 2-1001).
export type Race = 'human' | 'elf' | 'gargoyle';

function unit(seed: string, salt: string): number {
  let hash = 2166136261;
  for (const character of `${salt}:${seed}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash / 2 ** 32;
}

// Each race's creation code; its skins, hair hues, hair and beards follow ServUO's race rules.
const codes: Record<Race, number> = { human: 2, elf: 4, gargoyle: 6 };
const looks = Object.fromEntries(
  (Object.keys(codes) as Race[]).map((race) => {
    const rules = races.find((r) => r.name.toLowerCase() === race);
    if (!rules) throw new Error(`ServUO defines no ${race} race.`);
    return [race, { code: codes[race], ...rules }];
  })
) as Record<Race, (typeof races)[number] & { code: number }>;

// Race and sex alone, picked exactly as appearanceOf does (names.ts names by them).
export function lookOf(residentId: string, races: readonly Race[]): { race: Race; female: boolean } {
  const allowed: readonly Race[] = races.length ? races : ['human'];
  return {
    race: allowed[Math.floor(unit(residentId, 'race') * allowed.length)] as Race,
    female: unit(residentId, 'sex') < 0.5
  };
}

export function appearanceOf(residentId: string, races: readonly Race[]): Appearance {
  const pick = <T>(list: readonly T[], salt: string): T => list[Math.floor(unit(residentId, salt) * list.length)] as T;
  const female = unit(residentId, 'sex') < 0.5;
  const allowed: readonly Race[] = races.length ? races : ['human'];
  const race = looks[pick(allowed, 'race')];
  const hairHue = pick(race.hairHues, 'hair-hue');
  const beards = race.beards[female ? 'female' : 'male'];
  // Some men shave; everyone else picks a style.
  const beard = beards.length && unit(residentId, 'beard') < 0.6 ? pick(beards, 'beard-style') : 0;
  return {
    genderRace: race.code + (female ? 1 : 0),
    skinHue: pick(race.skins, 'skin'),
    hair: pick(race.hair[female ? 'female' : 'male'], 'hair'),
    hairHue,
    beard,
    beardHue: beard ? hairHue : 0,
    shirtHue: 2 + Math.floor(unit(residentId, 'shirt') * 1000),
    pantsHue: 2 + Math.floor(unit(residentId, 'pants') * 1000)
  };
}
