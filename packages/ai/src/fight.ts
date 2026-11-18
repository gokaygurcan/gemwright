import { creatures, skillOf } from '@gemwright/common/game/rules';

import type { HistoryEvent } from './history';
import { gaining } from './knowledge';
import { Self } from './self';

type Data = Record<string, unknown>;
type Mean = { sum: number; n: number };

const facts = new Map(creatures.map((c) => [c.type, c]));
const mean = (m: Mean | undefined) => (m?.n ? m.sum / m.n : undefined);
const median = (values: number[] | undefined) =>
  values?.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : undefined;
const sample = (into: Map<string, number[]>, key: string, value: number) =>
  into.set(key, [...(into.get(key) ?? []), value].slice(-100));
// The damage spells of each circle (ServUO Spells: Magic Arrow 10+1d4, Harm 17+1d5, Fireball 19+1d5,
// Lightning 23+1d4, Energy Bolt 40+1d5, Flamestrike 48+1d5).
const spells = [
  { circle: 1, bonus: 10, sides: 4 },
  { circle: 2, bonus: 17, sides: 5 },
  { circle: 3, bonus: 19, sides: 5 },
  { circle: 4, bonus: 23, sides: 4 },
  { circle: 6, bonus: 40, sides: 5 },
  { circle: 7, bonus: 48, sides: 5 }
];
// What one cast of a creature does on average and its mean square: a damage spell its Magery can
// cast, any of them alike, landing with the chance its Magery has across that circle's window (100/7
// per circle, 20 either side; MagerySpell) and scaled by its Evaluating Intelligence and Int
// (Spell.GetNewAosDamage), what one that lands does, and the seconds between casts (MageAI
// GetCastDelay: the circle's cast delay, 0.25s a circle from 1s, its 1.5s recovery and 1s more).
// Nothing for a creature that casts no magic.
function spellDamage(c: { magery: number; evalInt: number; int: number[] | null }) {
  if (!c.magery) return undefined;
  const [low = 0, high = low] = c.int ?? [];
  const scale = ((30 + 0.9 * c.evalInt) / 100) * ((100 + (low + high) / 2 / 10) / 100);
  const castable = spells
    .map((s) => {
      const middle = (100 / 7) * s.circle;
      const chance = Math.min(1, Math.max(0, (c.magery - (middle - 20)) / 40));
      const mean = (s.bonus + (s.sides + 1) / 2) * scale;
      const square = (((s.sides + 1) * (2 * s.sides + 1)) / 6 + s.bonus * (s.sides + 1) + s.bonus ** 2) * scale ** 2;
      return { chance, mean, square, seconds: 0.75 + 0.25 * s.circle + 1.5 + 1 };
    })
    .filter((s) => s.chance > 0);
  if (!castable.length) return undefined;
  return {
    mean: castable.reduce((sum, s) => sum + s.chance * s.mean, 0) / castable.length,
    square: castable.reduce((sum, s) => sum + s.chance * s.square, 0) / castable.length,
    landed: castable.reduce((sum, s) => sum + s.chance * s.mean, 0) / castable.reduce((sum, s) => sum + s.chance, 0),
    seconds: castable.reduce((sum, s) => sum + s.seconds, 0) / castable.length
  };
}

const fists = { seconds: 2.5, damage: 3.5 };

// What so many tries of some skills teach, each try as ServUO's gain chance has it.
function taught(
  tries: number,
  skills: string[],
  value: (skill: string) => number,
  total: number,
  odds: number
): { skill: number; skills: Record<string, number> } {
  const learned: Record<string, number> = {};
  // A check it cannot fail teaches nothing (SkillCheck.Mobile_SkillCheckDirectLocation: "No challenge").
  if (odds >= 1) return { skill: 0, skills: learned };
  for (const skill of skills) {
    const each = gaining(skill, value(skill), total, odds).skill ?? 0;
    if (each) learned[skill] = each * tries;
  }
  return { skill: Object.values(learned).reduce((a, b) => a + b, 0), skills: learned };
}

const together = (...parts: { skill: number; skills: Record<string, number> }[]) => ({
  skill: parts.reduce((sum, p) => sum + p.skill, 0),
  skills: Object.assign({}, ...parts.map((p) => p.skills)) as Record<string, number>
});

// The standard normal's cumulative chance (Abramowitz and Stegun 7.1.26).
const normal = (z: number) => {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const tail =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
    Math.exp((-z * z) / 2);
  return z >= 0 ? 1 - tail / 2 : tail / 2;
};
// The chance a loss close to normal reaches the health it has.
const dying = (lost: number, variance: number, health: number) => {
  const spread = Math.sqrt(variance);
  return spread ? 1 - normal((health - lost) / spread) : lost >= health ? 1 : 0;
};
const swingActions = new Set([4, 5, 6, 9, 10, 11, 12, 13, 14, 26, 27, 28, 29]);
const castActions = new Set([16, 17]);
// What a mobile's animation is, as clients see it: an attack (SA type 0, or an old-style swing), a
// cast (SA type 11, or an old-style 16-17), or neither.
export const motion = (data: { type?: unknown; action?: unknown }) =>
  (data.type === null ? swingActions.has(data.action as number) : data.type === 0)
    ? 'attack'
    : (data.type === null ? castActions.has(data.action as number) : data.type === 11)
      ? 'cast'
      : undefined;
const add = (into: Map<string, Mean>, key: string, value: number) => {
  const m = into.get(key) ?? { sum: 0, n: 0 };
  m.sum += value;
  m.n++;
  into.set(key, m);
};
const middle = (range: readonly number[] | null) => {
  const [low, high = low] = range ?? [];
  return low === undefined ? undefined : (low + (high ?? low)) / 2;
};
// ServUO's hit chance from AOS on (BaseWeapon.CheckHit): the attacker's weapon skill against the
// defender's, never below 2%. A creature fights with its fists: its Wrestling.
const hitChance = (attack: number, defend: number) => Math.min(1, Math.max(0.02, (attack + 20) / ((defend + 20) * 2)));

// How fights go, from what the resident sees of them: how often and how hard it and each kind of
// creature strike. With the hit chance and a creature's facts from the wiki, it foresees a fight it
// has never had: how long the kill takes, what it costs in health, whether it lives through it, and
// the gold the creature carries.
export class Fight {
  // What it is (self.ts): the skills it fights with, kept there and nowhere else. A fight weighed on
  // its own, with no mind about it, keeps a sheet of its own from what it observes.
  private readonly sheet: Self;
  private readonly own: boolean;
  constructor(sheet?: Self) {
    this.sheet = sheet ?? new Self();
    this.own = !sheet;
  }

  snapshot() {
    const { sheet: _, own: __, ...state } = this;
    return state;
  }

  restore(state: ReturnType<Fight['snapshot']>) {
    Object.assign(this, state);
  }

  private self = -1;
  private readonly weapons = new Map<number, string[]>();
  private readonly struck = new Map<number, number>();
  private readonly cast = new Map<number, number>();
  private combatant?: number;
  private striker?: number;
  // The mobiles whose blows or spells have reached it.
  private readonly foes = new Set<number>();
  // The mobiles it has fought itself: one of these that strikes it only answers its attack.
  private readonly engaged = new Set<number>();
  // Of each kind, how many came close to it and how many of those struck it first: how ready that
  // kind is to start a fight, as it has seen it here.
  private readonly met = new Map<string, Set<number>>();
  private readonly started = new Map<string, number>();
  // The last other mobile seen swinging or casting: what damage that follows it is blamed on.
  blamed?: number;
  private spelled = false;
  // Seconds between swings and damage per hit: 'me', each kind by name, and 'creatures' together.
  // Swing time is the median of what it has seen, so the pauses between fights do not count.
  private readonly intervals = new Map<string, number[]>();
  private readonly hits = new Map<string, Mean>();

  observe(event: HistoryEvent, nameOf: (serial: number) => string | undefined) {
    if (this.own) this.sheet.observe(event);
    const data = event.data as Data;
    switch (event.kind) {
      case 'awake':
        this.weapons.clear();
        this.self = data.serial as number;
        break;
      case 'gained':
      case 'revealed':
      case 'changed':
        if (
          (data.parent !== undefined && data.parent !== this.self) ||
          ('layer' in data && data.layer !== 1 && data.layer !== 2)
        )
          this.weapons.delete(data.serial as number);
        else if (data.layer === 1 || data.layer === 2 || this.weapons.has(data.serial as number))
          this.weapons.set(
            data.serial as number,
            (data.is as string[] | undefined) ?? nameOf(data.serial as number)?.split('/') ?? []
          );
        break;
      case 'lost':
        this.weapons.delete(data.serial as number);
        break;
      case 'screen':
        if ((data as { key?: string }).key === 'combatant') {
          this.combatant = (data.value as number | null) ?? undefined;
          if (this.combatant !== undefined) {
            if (this.engaged.size >= 2000) this.engaged.delete(this.engaged.values().next().value as number);
            this.engaged.add(this.combatant);
          }
        }
        break;
      case 'animated': {
        // An attack as clients see it: SA type 0, or an old-style swing action (a creature's 4-6, a
        // person's 9-14 on foot or 26-29 mounted).
        const serial = data.serial as number;
        // A cast: SA type 11, or an old-style 16-17. Damage that follows may be a spell's.
        const cast = data.type === null ? castActions.has(data.action as number) : data.type === 11;
        if (cast && serial !== this.self) {
          this.blamed = serial;
          this.spelled = true;
          this.striker = serial;
          const last = this.cast.get(serial);
          this.cast.set(serial, event.at);
          const name = nameOf(serial);
          if (last !== undefined) {
            sample(this.intervals, 'casting', (event.at - last) / 1000);
            if (name) sample(this.intervals, `casting ${name}`, (event.at - last) / 1000);
          }
        }
        const attack = data.type === null ? swingActions.has(data.action as number) : data.type === 0;
        if (!attack) break;
        const last = this.struck.get(serial);
        this.struck.set(serial, event.at);
        if (serial !== this.self) {
          this.striker = this.blamed = serial;
          this.spelled = false;
        }
        if (last === undefined) break;
        const seconds = (event.at - last) / 1000;
        if (serial === this.self) sample(this.intervals, 'me', seconds);
        else {
          sample(this.intervals, 'creatures', seconds);
          const name = nameOf(serial);
          if (name) sample(this.intervals, name, seconds);
        }
        break;
      }
      case 'damage': {
        const serial = Number(data.key);
        const amount = (data.value as { amount: number }).amount;
        const from = this.spelled ? this.blamed : this.striker;
        if (serial === this.self && from !== undefined && !this.foes.has(from)) {
          this.foes.add(from);
          const name = nameOf(from);
          if (name && !this.engaged.has(from)) {
            this.near(from, name);
            this.started.set(name, (this.started.get(name) ?? 0) + 1);
          }
        }
        if (serial === this.self && this.spelled) {
          // A spell's: how much of what the wiki says it does reaches it, its resistances as felt.
          const name = this.blamed === undefined ? undefined : nameOf(this.blamed);
          const landed = name ? this.spell(name)?.landed : undefined;
          if (landed) add(this.hits, 'resisted', amount / landed);
        } else if (serial === this.self) {
          const name = this.striker === undefined ? undefined : nameOf(this.striker);
          if (name) add(this.hits, name, amount);
          // How much of a blow its listed damage reaches it: its armour and resistances, as felt.
          const listed = name ? this.listed(name) : undefined;
          if (listed) add(this.hits, 'absorbed', amount / listed);
        } else if (serial === this.combatant) add(this.hits, 'me', amount);
        break;
      }
    }
  }

  // What the spells of a creature of these possible kinds do to it: as the wiki says, scaled by how
  // much of them it has felt reach it.
  private spell(name: string) {
    const casting = name
      .split('/')
      .flatMap((type) => facts.get(type) ?? [])
      .map(spellDamage)
      .filter((d) => d !== undefined);
    if (!casting.length) return undefined;
    const through = mean(this.hits.get('resisted')) ?? 1;
    const average = (pick: (d: (typeof casting)[number]) => number) =>
      casting.reduce((sum, d) => sum + pick(d), 0) / casting.length;
    return {
      mean: average((d) => d.mean) * through,
      square: average((d) => d.square) * through ** 2,
      landed: average((d) => d.landed),
      seconds: average((d) => d.seconds)
    };
  }

  // The damage the wiki lists for a creature of these possible kinds, at the middle of its range.
  private listed(name: string) {
    const values = name
      .split('/')
      .map((type) => middle(facts.get(type)?.damage ?? null))
      .filter((v) => v !== undefined);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  }

  // Whether a name it gives something is a kind of creature the wiki knows.
  isCreature(name: string | undefined) {
    return !!name && name.split('/').some((type) => facts.has(type));
  }

  // A creature of this kind came close to it.
  near(serial: number, name: string) {
    if (this.engaged.has(serial)) return;
    const seen = this.met.get(name) ?? new Set<number>();
    if (seen.size >= 500) seen.delete(seen.values().next().value as number);
    seen.add(serial);
    this.met.set(name, seen);
  }

  // How likely one of this kind is to start a fight with it, from what those that came close did:
  // even odds before it has met any.
  aggression(name: string) {
    return ((this.started.get(name) ?? 0) + 1) / ((this.met.get(name)?.size ?? 0) + 2);
  }

  // Whether this mobile has struck it.
  foe(serial: number) {
    return this.foes.has(serial);
  }

  skill(name: string) {
    return this.sheet.skill(name);
  }

  // All its skills together, as the shard caps them.
  get skillTotal() {
    return this.sheet.skillTotal;
  }

  // What a creature of these possible kinds takes from it over so many seconds of its blows and
  // spells, as a mean and variance: each blow lands with the hit chance for damage across its range,
  // so their total is close to normal. Nothing while it has not seen how hard such a one strikes.
  private harm(name: string, seconds: number) {
    const kinds = this.kinds(name);
    const average = (pick: (c: (typeof kinds)[number]) => number | undefined) => mean(this.sum(kinds.map(pick)));
    const itsSkill = average((c) => c.wrestling);
    const itsInterval = median(this.intervals.get(name)) ?? median(this.intervals.get('creatures')) ?? fists.seconds;
    const listed = this.listed(name);
    const itsDamage =
      mean(this.hits.get(name)) ?? (listed === undefined ? undefined : listed * (mean(this.hits.get('absorbed')) ?? 1));
    if (itsSkill === undefined || itsDamage === undefined) return undefined;
    const blows = seconds / itsInterval;
    const lands = hitChance(itsSkill, this.sheet.skill(this.weaponSkill));
    const low = average((c) => c.damage?.[0]) ?? itsDamage;
    const high = average((c) => c.damage?.at(-1)) ?? itsDamage;
    const scale = itsDamage / ((low + high) / 2 || 1);
    const square = ((low * low + low * high + high * high) / 3) * scale * scale;
    let lost = blows * lands * itsDamage;
    let variance = blows * (lands * square - (lands * itsDamage) ** 2);
    // A caster's spells come on top of its blows, as often as casters have been seen to cast, or as
    // ServUO paces them before it has seen one.
    const spell = this.spell(name);
    if (spell) {
      const every =
        median(this.intervals.get(`casting ${name}`)) ?? median(this.intervals.get('casting')) ?? spell.seconds;
      const casts = seconds / every;
      lost += casts * spell.mean;
      variance += casts * (spell.square - spell.mean ** 2);
    }
    return { lost, variance };
  }

  // The chance it dies of what these creatures take from it over so many seconds, each counted as
  // likely as it is to join in.
  endured(foes: readonly { name: string; weight: number }[], seconds: number, health: number | null) {
    if (health === null || !foes.length) return 0;
    const harms = foes.flatMap(({ name, weight }) => {
      const harm = this.harm(name, seconds);
      return harm ? [{ lost: harm.lost * weight, variance: harm.variance * weight }] : [];
    });
    return dying(
      harms.reduce((sum, h) => sum + h.lost, 0),
      harms.reduce((sum, h) => sum + h.variance, 0),
      health
    );
  }

  private kinds(name: string) {
    return name
      .split('/')
      .map((type) => facts.get(type))
      .filter((c) => c !== undefined);
  }

  private sum(values: (number | undefined)[]): Mean | undefined {
    const known = values.filter((v) => v !== undefined);
    return { sum: known.reduce((a, b) => a + b, 0), n: known.length };
  }

  private get weaponSkill() {
    const weapon = [...this.weapons.values()].flat().find((type) => skillOf(type));
    return weapon ? (skillOf(weapon) ?? 'Wrestling') : 'Wrestling';
  }

  // What attacking a creature of these possible kinds should bring, or nothing while it has not yet
  // seen how fast and how hard it strikes.
  foresee(name: string, health: number | null, remaining = 1) {
    const kinds = this.kinds(name);
    const average = (pick: (c: (typeof kinds)[number]) => number | undefined) => mean(this.sum(kinds.map(pick)));
    const itsHits = average((c) => middle(c.hits));
    const itsSkill = average((c) => c.wrestling);
    // Before it has seen a blow, every blow is a bare fist's (ServUO Fists: 2.5 seconds, 1-6 damage).
    const myInterval = median(this.intervals.get('me')) ?? fists.seconds;
    const myDamage = mean(this.hits.get('me')) ?? fists.damage;
    if (itsHits === undefined || itsSkill === undefined) return undefined;
    const weaponSkill = this.weaponSkill;
    const mySkill = this.sheet.skill(weaponSkill);
    const odds = hitChance(mySkill, itsSkill);
    const seconds = (itsHits * remaining) / ((odds * myDamage) / myInterval);
    const harm = this.harm(name, seconds);
    if (!harm) return undefined;
    const lost = harm.lost;
    const died = health === null ? 0 : dying(harm.lost, harm.variance, health);
    const gold = average((c) => c.gold) ?? 0;
    const swung = seconds / myInterval;
    return {
      seconds,
      health: -Math.min(lost, health ?? lost),
      killed: 1 - died,
      died,
      gained: (gold ? { Gold: gold * (1 - died) } : {}) as Record<string, number>,
      // What it may learn: its weapon's skill a check a swing, at the odds of landing it, and Tactics a
      // check a blow that lands, at its own Tactics against its cap (BaseWeapon CheckHit, ScaleDamageAOS).
      ...together(
        taught(swung, [weaponSkill], (skill) => this.sheet.skill(skill), this.skillTotal, odds),
        taught(
          swung * odds,
          ['Tactics'],
          (skill) => this.sheet.skill(skill),
          this.skillTotal,
          this.sheet.skill('Tactics') / 100
        )
      )
    };
  }
}
