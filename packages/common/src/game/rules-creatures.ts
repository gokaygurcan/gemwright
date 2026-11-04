// A creature's facts from its ServUO script (Scripts/Mobiles constructors, the numbers uoguide.com
// publishes): health, damage, combat skills, armor, whether it attacks on sight (FightMode Closest,
// Strongest, Weakest or Evil), its AI, the gold its loot packs carry and whether it can be tamed.
export interface CreatureFacts {
  name: string | null;
  hits: number[] | null;
  damage: number[] | null;
  magery: number;
  resist: number;
  poison: number;
  fame: number;
  aggressive: boolean;
  ai: string | null;
  fightMode: string;
  tactics: number;
  wrestling: number;
  armor: number;
  gold: number;
  minTame?: number;
}

// Rough gold of one ServUO loot pack (LootPack.cs gold entries, averaged).
const packGold: Record<string, number> = {
  Poor: 15,
  Meager: 40,
  Average: 100,
  Rich: 250,
  FilthyRich: 500,
  UltraRich: 900,
  SuperBoss: 1500
};
const range = (body: string, call: string) => {
  const match = new RegExp(`${call}\\(\\s*(\\d+)(?:\\s*,\\s*(\\d+))?\\s*\\)`).exec(body);
  return match ? [Number(match[1]), Number(match[2] ?? match[1])] : null;
};

// The facts of a creature class, from its whole body; the AI and FightMode its base constructor
// call names, else its nearest creature base's (`base`).
export function creatureFacts(body: string, base?: CreatureFacts): CreatureFacts | undefined {
  const mode = /FightMode\.(\w+)/.exec(body)?.[1] ?? base?.fightMode;
  if (!mode) return undefined;
  const strength = range(body, 'SetStr');
  const tamable = /\bTamable\s*=\s*true/.test(body);
  const minTame = Number(/\bMinTameSkill\s*=\s*(-?[\d.]+)/.exec(body)?.[1]);
  // A number the script sets, else the one its base constructor set.
  const own = (pattern: RegExp, inherited = 0) => {
    const value = pattern.exec(body)?.[1];
    return value === undefined ? inherited : Number(value);
  };
  const skillOf = (name: string, inherited = 0) =>
    own(new RegExp(`SkillName\\.${name},\\s*[\\d.]+,\\s*([\\d.]+)`), inherited);
  const loot = [...body.matchAll(/AddLoot\(\s*LootPack\.(\w+)(?:\s*,\s*(\d+))?/g)];
  return {
    name:
      /\bName\s*=\s*"([^"]+)"/.exec(body)?.[1] ??
      /:\s*(?:base|this)\(\s*"([^"]+)"/.exec(body)?.[1] ??
      base?.name ??
      null,
    hits: range(body, 'SetHits') ?? strength ?? base?.hits ?? null,
    damage: range(body, 'SetDamage') ?? base?.damage ?? null,
    magery: skillOf('Magery', base?.magery),
    resist: skillOf('MagicResist', base?.resist),
    poison: skillOf('Poisoning', base?.poison),
    fame: own(/\bFame\s*=\s*(\d+)/, base?.fame),
    aggressive: ['Closest', 'Strongest', 'Weakest', 'Evil'].includes(mode),
    ai: /AIType\.AI_(\w+)/.exec(body)?.[1] ?? base?.ai ?? null,
    fightMode: mode,
    tactics: skillOf('Tactics', base?.tactics),
    wrestling: skillOf('Wrestling', base?.wrestling),
    armor: own(/\bVirtualArmor\s*=\s*(\d+)/, base?.armor),
    gold: loot.length
      ? loot.reduce((sum, [, pack, times]) => sum + (packGold[pack ?? ''] ?? 0) * Number(times ?? 1), 0)
      : (base?.gold ?? 0),
    ...(tamable && Number.isFinite(minTame) && { minTame })
  };
}
