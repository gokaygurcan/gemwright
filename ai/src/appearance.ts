// What a new character looks like: sex, race, skin, hair, beard and the colours of its starting
// shirt and pants, chosen at the creation screen like any player would. Values derive from the
// resident id (as temperament does), so they are stable, and stay within ServUO's race rules
// (Scripts/Misc/RaceDefinitions.cs): about half are women, races come from gemwright.json
// (`ai.races`), shirt and pants take dyeable hues (CharacterCreation ClipDyedHue, 2-1001).
export type Race = 'human' | 'elf' | 'gargoyle';
export interface Appearance {
  // Creation packet byte: 2/3 human male/female, 4/5 elf, 6/7 gargoyle (classic 7.0+ clients).
  genderRace: number;
  skinHue: number;
  hair: number;
  hairHue: number;
  beard: number;
  beardHue: number;
  shirtHue: number;
  pantsHue: number;
}

function unit(seed: string, salt: string): number {
  let hash = 2166136261;
  for (const character of `${salt}:${seed}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash / 2 ** 32;
}

const range = (low: number, high: number) => Array.from({ length: high - low + 1 }, (_, i) => low + i);
const elfSkins = [
  0x4de, 0x76c, 0x835, 0x430, 0x24d, 0x24e, 0x24f, 0x0bf, 0x4a7, 0x361, 0x375, 0x367, 0x3e8, 0x3de, 0x353, 0x903, 0x76d,
  0x384, 0x579, 0x3e9, 0x374, 0x389, 0x385, 0x376, 0x53f, 0x381, 0x382, 0x383, 0x76b, 0x3e5, 0x51d, 0x3e6
];
const elfHairHues = [
  0x034, 0x035, 0x036, 0x037, 0x038, 0x039, 0x058, 0x08e, 0x08f, 0x090, 0x091, 0x092, 0x101, 0x159, 0x15a, 0x15b, 0x15c,
  0x15d, 0x15e, 0x128, 0x12f, 0x1bd, 0x1e4, 0x1f3, 0x207, 0x211, 0x239, 0x251, 0x26c, 0x2c3, 0x2c9, 0x31d, 0x31e, 0x31f,
  0x320, 0x321, 0x322, 0x323, 0x324, 0x325, 0x326, 0x369, 0x386, 0x387, 0x388, 0x389, 0x38a, 0x59d, 0x6b8, 0x725, 0x853
];
const hornHues = [
  0x709, 0x70b, 0x70d, 0x70f, 0x711, 0x763, 0x765, 0x768, 0x76b, 0x6f3, 0x6f1, 0x6ef, 0x6e4, 0x6e2, 0x6e0
];
const looks: Record<
  Race,
  {
    code: number;
    skins: number[];
    hairHues: number[];
    hair: (female: boolean) => number[];
    beards: (female: boolean) => number[];
  }
> = {
  human: {
    code: 2,
    skins: range(1002, 1058),
    hairHues: range(1102, 1149),
    // Short, long, ponytail, mohawk, pageboy, afro, pigtails, krisna; buns for women, receding for men.
    hair: (female) => [0x203b, 0x203c, 0x203d, 0x2044, 0x2045, 0x2047, 0x2049, 0x204a, female ? 0x2046 : 0x2048],
    beards: (female) => (female ? [] : [0x203e, 0x203f, 0x2040, 0x2041, 0x204b, 0x204c, 0x204d])
  },
  elf: {
    code: 4,
    skins: elfSkins,
    hairHues: elfHairHues,
    // Long feather, short, mullet, knob, braided, spiked; flower or mid-long; bun or long.
    hair: (female) => [
      0x2fc0,
      0x2fc1,
      0x2fc2,
      0x2fce,
      0x2fcf,
      0x2fd1,
      female ? 0x2fcc : 0x2fbf,
      female ? 0x2fd0 : 0x2fcd
    ],
    beards: () => []
  },
  gargoyle: {
    code: 6,
    skins: range(1755, 1779),
    hairHues: hornHues,
    hair: (female) =>
      female ? range(0x4258, 0x425f) : [0x4261, 0x4262, 0x4273, 0x4274, 0x4275, 0x42b0, 0x42b1, 0x42aa, 0x42ab],
    beards: (female) => (female ? [] : [0x42ad, 0x42ae, 0x42af, 0x42b0])
  }
};

export function appearanceOf(residentId: string, races: readonly Race[]): Appearance {
  const pick = <T>(list: readonly T[], salt: string): T => list[Math.floor(unit(residentId, salt) * list.length)] as T;
  const female = unit(residentId, 'sex') < 0.5;
  const allowed: readonly Race[] = races.length ? races : ['human'];
  const race = looks[pick(allowed, 'race')];
  const hairHue = pick(race.hairHues, 'hair-hue');
  const beards = race.beards(female);
  // Some men shave; everyone else picks a style.
  const beard = beards.length && unit(residentId, 'beard') < 0.6 ? pick(beards, 'beard-style') : 0;
  return {
    genderRace: race.code + (female ? 1 : 0),
    skinHue: pick(race.skins, 'skin'),
    hair: pick(race.hair(female), 'hair'),
    hairHue,
    beard,
    beardHue: beard ? hairHue : 0,
    shirtHue: 2 + Math.floor(unit(residentId, 'shirt') * 1000),
    pantsHue: 2 + Math.floor(unit(residentId, 'pants') * 1000)
  };
}
