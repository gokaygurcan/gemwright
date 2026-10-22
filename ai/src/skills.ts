export const skillNames = [
  'Alchemy',
  'Anatomy',
  'AnimalLore',
  'ItemID',
  'ArmsLore',
  'Parry',
  'Begging',
  'Blacksmith',
  'Fletching',
  'Peacemaking',
  'Camping',
  'Carpentry',
  'Cartography',
  'Cooking',
  'DetectHidden',
  'Discordance',
  'EvalInt',
  'Healing',
  'Fishing',
  'Forensics',
  'Herding',
  'Hiding',
  'Provocation',
  'Inscribe',
  'Lockpicking',
  'Magery',
  'MagicResist',
  'Tactics',
  'Snooping',
  'Musicianship',
  'Poisoning',
  'Archery',
  'SpiritSpeak',
  'Stealing',
  'Tailoring',
  'AnimalTaming',
  'TasteID',
  'Tinkering',
  'Tracking',
  'Veterinary',
  'Swords',
  'Macing',
  'Fencing',
  'Wrestling',
  'Lumberjacking',
  'Mining',
  'Meditation',
  'Stealth',
  'RemoveTrap',
  'Necromancy',
  'Focus',
  'Chivalry',
  'Bushido',
  'Ninjitsu',
  'Spellweaving',
  'Mysticism',
  'Imbuing',
  'Throwing'
];

const key = (name: string) => name.replace(/[^a-z]/gi, '').toLowerCase();
const ids = new Map(skillNames.map((name, index) => [key(name), index]));
for (const [alias, name] of Object.entries({
  Swordsmanship: 'Swords',
  'Mace Fighting': 'Macing',
  Blacksmithy: 'Blacksmith',
  Parrying: 'Parry',
  Inscription: 'Inscribe',
  'Evaluate Intelligence': 'EvalInt',
  'Evaluating Intelligence': 'EvalInt',
  'Resisting Spells': 'MagicResist'
})) {
  const index = skillNames.indexOf(name);
  if (index < 0) throw new Error(`Invalid skill alias: ${alias}`);
  ids.set(key(alias), index);
}

export function skillId(name: string): number {
  const id = ids.get(key(name));
  if (id === undefined) throw new Error(`Unsupported skill: ${name}`);
  return id;
}
