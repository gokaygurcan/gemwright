import { readFileSync } from 'node:fs';

import type { FighterContext } from './fighter-context';
import type { Entity } from './protocol/world';
import { skillId } from './skills';

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
const state = new WeakMap<FighterContext, { missing: Set<number>; blessed: number; combo: string[] }>();

// Combat magery modelled on ServUO MageAI: cure first, heal by how badly hurt and how much mana
// there is (one fast Heal can save a fight a slow Greater Heal would lose), interrupt an enemy's
// spell with a quick Magic Arrow (damage disturbs a cast), bless once, poison an unpoisoned target,
// then damage by mana: Explosion into Energy Bolt or Flame Strike when rich, Lightning or Fireball
// otherwise, Magic Arrow when low. Returns whether a spell was cast this turn.
export async function castTurn(ctx: FighterContext, opponent: Entity, offensive = true): Promise<boolean> {
  const { session, status } = ctx;
  const memory = state.get(ctx) ?? { missing: new Set<number>(), blessed: 0, combo: [] };
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
  const spell = byName.get(choice);
  if (!spell || session.world.target) return false;
  const seen = new Set(session.world.journal);
  session.useSkill(spell.id, true);
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
  if (!session.world.target) {
    if (session.world.journal.some((e) => !seen.has(e) && e.cliloc === NO_SPELL)) memory.missing.add(spell.id);
    return false;
  }
  const target = self ? { serial: ctx.serial, graphic: 0 } : opponent;
  session.target({ serial: target.serial, x: 0, y: 0, z: 0, graphic: target.graphic });
  ctx.log(`Cast ${spell.name}${self ? ' on myself' : ` at ${opponent.name ?? opponent.serial}`}`);
  return true;
}

// Reagents a caster keeps for combat, as restock targets.
export const combatReagents = Object.values(reagentGraphics);
