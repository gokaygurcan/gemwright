import { readFileSync } from 'node:fs';

import { HUMAN_BODIES } from '@gemwright/common/bodies';
import { skillId } from '@gemwright/common/skills';

import type { FighterContext } from './fighter-context';
import { distance } from './navigation';
import type { Entity } from './protocol/world';

interface SpellDef {
  name: string;
  id: number;
  circle: number;
  words: string;
  reagents: string[];
}
const spells = (
  JSON.parse(readFileSync(new URL('../catalogs/magery-spells.json', import.meta.url), 'utf8')) as {
    spells: SpellDef[];
  }
).spells;
const byName = new Map(spells.map((spell) => [spell.name, spell]));
export const reagentGraphics: Record<string, number> = {
  BlackPearl: 0x0f7a,
  Bloodmoss: 0x0f7b,
  Garlic: 0x0f84,
  Ginseng: 0x0f85,
  MandrakeRoot: 0x0f86,
  Nightshade: 0x0f88,
  SulfurousAsh: 0x0f8c,
  SpidersSilk: 0x0f8d
};
// MagerySpell mana per circle (ServUO m_ManaTable).
const MANA = [0, 4, 6, 9, 11, 14, 20, 40, 50];
const NO_SPELL = 500015;

// Per-fight memory: spells missing from the book, buffs already cast, the current combo step.
const state = new WeakMap<
  FighterContext,
  { missing: Set<number>; blessed: number; combo: string[]; summoned?: { serial?: number; until: number } }
>();

// Summons (ServUO SummonCreatureSpell and the 8th-circle summons): controlled ones serve the
// caster and take "all kill" orders like a tamer's pet; blade spirits and energy vortex pick their
// own targets, so they are only cast where nothing friendly stands within eight tiles of the spot
// and the caster is at least five tiles away. One summon at a time, with mana left to fight on.
const controlled = [
  'Summon Daemon',
  'Air Elemental',
  'Earth Elemental',
  'Water Elemental',
  'Fire Elemental',
  'Summon Creature'
];
const wild = ['Energy Vortex', 'Blade Spirits'];
const humans = HUMAN_BODIES;

// Combat magery modelled on ServUO MageAI: cure first, heal by how badly hurt and how much mana
// there is (one fast Heal can save a fight a slow Greater Heal would lose), interrupt an enemy's
// spell with a quick Magic Arrow (damage disturbs a cast), bless once, poison an unpoisoned target,
// then damage by mana: Explosion into Energy Bolt or Flame Strike when rich, Lightning or Fireball
// otherwise, Magic Arrow when low. Returns whether a spell was cast this turn.
export async function castTurn(ctx: FighterContext, opponent: Entity, offensive = true): Promise<boolean> {
  const { session, status } = ctx;
  const memory = state.get(ctx) ?? { missing: new Set<number>(), blessed: 0, combo: [] as string[] };
  state.set(ctx, memory);
  const skill = session.world.skills.get(skillId('Magery'))?.value ?? 0;
  const count = (graphic: number) =>
    ctx
      .contents()
      .filter((i) => i.graphic === graphic)
      .reduce((sum, i) => sum + (i.amount ?? 1), 0);
  // Reliable enough to cast: at least the circle's average gain skill (MagerySpell.GetCastSkills).
  const usable = (name: string) => {
    const spell = byName.get(name);
    return (
      !!spell &&
      !memory.missing.has(spell.id) &&
      skill >= 14.3 * (spell.circle - 1) &&
      status().mana >= (MANA[spell.circle] ?? 99) &&
      spell.reagents.every((r) => count(reagentGraphics[r] ?? 0) > 0)
    );
  };
  const pick = (...names: string[]) => names.find(usable);
  const hits = status().hits;
  const missingHits = status().maxHits - hits;
  const poisoned = (session.world.poisonLevel ?? 0) > 0;
  const enemyCasting = session.world.journal
    .slice(-6)
    .some(
      (e) =>
        e.serial === opponent.serial &&
        Date.now() - Date.parse(e.at) < 1500 &&
        spells.some((s) => e.text?.trim() === s.words)
    );
  const targetPoisoned = ((opponent.flags ?? 0) & 0x04) !== 0;
  let choice: string | undefined;
  let self = false;
  if (poisoned) {
    choice = pick((session.world.poisonLevel ?? 0) > 1 ? 'Arch Cure' : 'Cure', 'Cure');
    self = true;
  } else if (hits < status().maxHits * 0.35 || (missingHits > 10 && status().mana < 20)) {
    choice = pick('Heal');
    self = true;
  } else if (missingHits > 50) {
    choice = pick('Greater Heal', 'Heal');
    self = true;
  }
  if (!choice && offensive && (await summonTurn(ctx, opponent, usable, memory))) return true;
  if (!choice && offensive) {
    if (enemyCasting) choice = pick('Magic Arrow', 'Harm');
    else if (Date.now() - memory.blessed > 120_000 && usable('Bless')) {
      choice = 'Bless';
      self = true;
      memory.blessed = Date.now();
    } else if (memory.combo.length) choice = pick(memory.combo.shift() ?? '');
    else if (!targetPoisoned && status().mana > 15) choice = pick('Poison');
    else if (status().mana > 60 && usable('Explosion')) {
      choice = 'Explosion';
      memory.combo = [usable('Flame Strike') ? 'Flame Strike' : 'Energy Bolt'];
    } else choice = pick('Energy Bolt', 'Lightning', 'Fireball', 'Magic Arrow');
  }
  if (!choice) return false;
  const target = self ? { serial: ctx.serial, graphic: 0 } : opponent;
  return castSpell(ctx, choice, target, memory.missing);
}

// Casts a spell: at a mobile, at a spot on the ground, or with no target (a summon appears beside
// the caster). Returns whether the cast went off.
async function castSpell(
  ctx: FighterContext,
  name: string,
  aim: Entity | { serial: number; graphic: number } | { x: number; y: number; z: number } | null,
  missing: Set<number>
): Promise<boolean> {
  const { session } = ctx;
  const spell = byName.get(name);
  if (!spell || session.world.target) return false;
  const seen = new Set(session.world.journal);
  session.useSkill(spell.id, true);
  // A summon takes no target: it appears once the cast delay passes, unless the book lacks it.
  if (aim === null) {
    await Bun.sleep(1000 + (3 + spell.circle) * 250);
    if (session.world.journal.some((e) => !seen.has(e) && e.cliloc === NO_SPELL)) {
      missing.add(spell.id);
      return false;
    }
    ctx.log(`Cast ${spell.name}`);
    return true;
  }
  try {
    // ServUO cast delay is (3 + circle index) * 0.25 s before the target cursor opens.
    await session.waitFor(
      () => session.world.target !== null || session.world.journal.some((e) => !seen.has(e) && e.cliloc === NO_SPELL),
      'spell cursor',
      1000 + (2 + spell.circle) * 250
    );
  } catch {
    return false;
  }
  if (session.world.journal.some((e) => !seen.has(e) && e.cliloc === NO_SPELL)) {
    missing.add(spell.id);
    return false;
  }
  if (!session.world.target) return false;
  if ('serial' in aim) session.target({ serial: aim.serial, x: 0, y: 0, z: 0, graphic: aim.graphic });
  else session.target({ serial: 0, x: aim.x, y: aim.y, z: aim.z, graphic: 0 });
  ctx.log(
    `Cast ${spell.name}${'serial' in aim ? (aim.serial === ctx.serial ? ' on myself' : ` at ${aim.serial}`) : ` at ${aim.x},${aim.y}`}`
  );
  return true;
}

async function summonTurn(
  ctx: FighterContext,
  opponent: Entity,
  usable: (name: string) => boolean,
  memory: { missing: Set<number>; summoned?: { serial?: number; until: number } }
): Promise<boolean> {
  const { session, status } = ctx;
  if ((memory.summoned?.until ?? 0) > Date.now()) return false;
  const followers = status().followers ?? 0;
  if (followers >= (status().maxFollowers ?? 0) - 1 || status().mana < 60) return false;
  const here = ctx.position();
  const before = new Set([...session.world.entities.values()].filter((m) => m.kind === 'mobile').map((m) => m.serial));
  const tame = controlled.find(usable);
  if (tame && (await castSpell(ctx, tame, null, memory.missing))) {
    memory.summoned = { until: Date.now() + 60_000 };
    await session.waitFor(() => (status().followers ?? 0) > followers, 'summoned creature', 3000).catch(() => {});
    // Its first order: the opponent.
    session.say('all kill');
    await session.waitFor(() => session.world.target !== null, 'pet order cursor', 3000).catch(() => {});
    if (session.world.target) session.target({ serial: opponent.serial, x: 0, y: 0, z: 0, graphic: opponent.graphic });
    memory.summoned.serial = [...session.world.entities.values()].find(
      (m) => m.kind === 'mobile' && !before.has(m.serial) && m.position && distance(here, m.position) <= 3
    )?.serial;
    return true;
  }
  const spot = opponent.position;
  const wildOne = wild.find(usable);
  if (!wildOne || !spot || distance(here, spot) < 5) return false;
  const friendly = [...session.world.entities.values()].some(
    (m) =>
      m.kind === 'mobile' &&
      m.serial !== ctx.serial &&
      m.serial !== opponent.serial &&
      !!m.position &&
      distance(spot, m.position) <= 8 &&
      (humans.has(m.graphic) || [1, 2].includes(m.notoriety ?? 0))
  );
  if (friendly || !(await castSpell(ctx, wildOne, spot, memory.missing))) return false;
  memory.summoned = { until: Date.now() + 60_000 };
  return true;
}

// Reagents a caster keeps for combat, as restock targets.
export const combatReagents = Object.values(reagentGraphics);
