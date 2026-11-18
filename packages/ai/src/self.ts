import { creatures, kindsOf, skillOf } from '@gemwright/common/game/rules';

import { growth } from './growth';
import type { HistoryEvent } from './history';

export interface Sheet {
  value: number;
  base: number;
  cap: number;
  // 0 up, 1 down, 2 locked.
  lock: number;
}
type Data = Record<string, unknown>;
type Pair = { current: number; max: number };

const weaponSkills = new Set(
  kindsOf('BaseWeapon').flatMap((type) => {
    const skill = skillOf(type);
    return skill ? [skill] : [];
  })
);
// The skill each ServUO craft system (its Def* class) checks.
export const craftSkill: Readonly<Record<string, string>> = {
  DefAlchemy: 'Alchemy',
  DefGlassblowing: 'Alchemy',
  DefBlacksmithy: 'Blacksmith',
  DefBowFletching: 'Fletching',
  DefCarpentry: 'Carpentry',
  DefMasonry: 'Carpentry',
  DefCartography: 'Cartography',
  DefCooking: 'Cooking',
  DefInscription: 'Inscribe',
  DefTailoring: 'Tailoring',
  DefTinkering: 'Tinkering'
};
const craftSkills = new Set(Object.values(craftSkill));
const tamable = creatures.flatMap((c) =>
  c.minTame === undefined ? [] : [{ name: c.type, minTame: c.minTame, mount: c.mount }]
);

// What it is, as its status and skill windows show it, at every moment: each skill's value, base,
// cap and lock; its stats, their locks and cap; health, mana and stamina; how much it carries of what
// it can; its followers, resistances, luck and the damage of what it wields. Updated on every
// packet that changes any of it, never guessed.
export class Self {
  readonly skills = new Map<string, Sheet>();
  stats?: { strength: number; dexterity: number; intelligence: number };
  statCap?: number;
  statLocks?: number[];
  health?: Pair;
  mana?: Pair;
  stamina?: Pair;
  weight?: Pair;
  followers?: Pair;
  resists?: Record<string, number>;
  luck?: number;
  damage?: { min: number; max: number };
  body?: number;
  flying = false;
  notoriety?: number;
  poison = 0;
  // The shard's caps (Config/PlayerCaps.cfg, spawns.ts), when its world files carry them.
  caps?: { skill: number; total: number; stats: number; stat: number[] };
  // What its skills gained, newest last: what its growth is read from.
  readonly gains: { skill: string; at: number; delta: number }[] = [];

  snapshot() {
    return { ...this, skills: [...this.skills], gains: [...this.gains] };
  }

  restore(state: ReturnType<Self['snapshot']>) {
    const { skills, gains, ...rest } = state;
    Object.assign(this, rest);
    this.skills.clear();
    for (const [name, sheet] of skills) this.skills.set(name, sheet);
    this.gains.splice(0, this.gains.length, ...(gains ?? []));
  }

  observe(event: HistoryEvent) {
    const data = event.data as Data;
    switch (event.kind) {
      case 'awake': {
        this.poison = 0;
        this.notoriety = undefined;
        // A new session: its body as this one shows it.
        for (const key of ['health', 'mana', 'stamina', 'weight', 'followers'] as const) this[key] = undefined;
        const sheet = data.sheet as Record<string, Sheet> | undefined;
        if (sheet) {
          this.skills.clear();
          for (const [name, s] of Object.entries(sheet)) this.skills.set(name, s);
        } else
          for (const [name, value] of Object.entries((data.skills as Record<string, number>) ?? {}))
            this.skills.set(name, { ...(this.skills.get(name) ?? { base: value, cap: 100, lock: 0 }), value });
        this.read((data.self as Data) ?? {});
        break;
      }
      case 'skill': {
        const known = this.skills.get(String(data.skill));
        const value = data.value as number;
        if (typeof data.before === 'number' && value !== data.before) {
          this.gains.push({ skill: String(data.skill), at: event.at, delta: value - data.before });
          if (this.gains.length > 500) this.gains.splice(0, this.gains.length - 500);
        }
        this.skills.set(String(data.skill), {
          value,
          base: (data.base as number | undefined) ?? known?.base ?? value,
          cap: (data.cap as number | undefined) ?? known?.cap ?? 100,
          lock: (data.lock as number | undefined) ?? known?.lock ?? 0
        });
        break;
      }
      case 'self':
        this.read(data);
        break;
    }
  }

  private read(data: Data) {
    if (data.attributes) this.stats = data.attributes as Self['stats'];
    for (const key of ['health', 'mana', 'stamina', 'weight', 'followers'] as const)
      if (data[key]) this[key] = { ...this[key], ...(data[key] as Partial<Pair>) } as Pair;
    if (typeof data.statCap === 'number') this.statCap = data.statCap;
    if (Array.isArray(data.statLocks)) this.statLocks = data.statLocks as number[];
    if (data.resists) this.resists = data.resists as Record<string, number>;
    if (typeof data.luck === 'number') this.luck = data.luck;
    if (data.damage) this.damage = data.damage as Self['damage'];
    if (typeof data.body === 'number') this.body = data.body;
    if (typeof data.notoriety === 'number') this.notoriety = data.notoriety;
    if (typeof data.poison === 'number') this.poison = data.poison;
    if (typeof data.flying === 'boolean') this.flying = data.flying;
  }

  skill(name: string) {
    return this.skills.get(name)?.value ?? 0;
  }

  // How it grows against the shard's total skill cap (growth.ts).
  growth(now = Date.now()) {
    return growth(this.skills, this.gains, this.caps?.total ?? 700, now);
  }

  // All its skills' base values together: what the shard's total cap counts.
  get skillTotal() {
    let total = 0;
    for (const sheet of this.skills.values()) total += sheet.base;
    return total;
  }

  // What its skills and stats make it able to do, from ServUO's own rules, worked out afresh at
  // each asking: there is nothing here to go stale.
  abilities() {
    const dexterity = this.stats?.dexterity ?? 0;
    const parry = this.skill('Parry');
    const bushido = this.skill('Bushido');
    // BaseWeapon.CheckParry: low dexterity scales any parry down; 100 in parrying adds 5%.
    const scaled = (chance: number) =>
      Math.max(0, Math.min(1, (chance + (parry >= 100 ? 0.05 : 0)) * (dexterity < 80 ? (20 + dexterity) / 100 : 1)));
    const ranked = (names: Iterable<string>) =>
      [...names]
        .map((name) => ({ skill: name, value: this.skill(name) }))
        .filter((s) => s.value > 0)
        .sort((a, b) => b.value - a.value);
    const taming = this.skill('AnimalTaming');
    return {
      weapons: ranked(weaponSkills),
      crafts: ranked(craftSkills),
      parry: {
        // With a shield: (parrying - bushido) / 400.
        shield: scaled(Math.max(0, (parry - bushido) / 400)),
        // With a one-handed or two-handed weapon and no shield: at least parrying / 800.
        oneHanded: scaled(Math.max((parry * bushido) / 48000, parry / 800)),
        twoHanded: scaled(Math.max((parry * bushido) / 41140, parry / 800))
      },
      // AnimalTaming: refused below a creature's tame skill; above it the roll spans 50 points.
      tames: tamable
        .filter((c) => taming >= c.minTame)
        .map((c) => ({ ...c, chance: Math.min(1, (taming - c.minTame + 0.1) / 50) }))
        .sort((a, b) => b.minTame - a.minTame),
      carries: this.weight ? Math.max(0, this.weight.max - this.weight.current) : undefined,
      followers: this.followers ? Math.max(0, this.followers.max - this.followers.current) : undefined
    };
  }
}
