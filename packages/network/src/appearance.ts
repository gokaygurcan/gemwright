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
