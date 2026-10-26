import { readFileSync } from 'node:fs';

import { HUMAN_BODIES } from '@gemwright/common/bodies';
import { skillId } from '@gemwright/common/skills';

import type { FighterContext } from './fighter-context';
import { allyUnderPressure } from './group-awareness';
import { distance } from './navigation';
import type { Entity } from './protocol/world';
import { rememberPartner } from './resident-memory';
import { requestSpell } from './spell-action';

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

// Per-fight memory: spells missing from the book, buffs already cast, the current combo step.
const state = new WeakMap<
  FighterContext,
  {
    missing: Set<number>;
    blessed: number;
    combo: string[];
    retry: Map<string, number>;
    summoned?: { serial?: number; until: number };
  }
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
  const memory = state.get(ctx) ?? {
    missing: new Set<number>(),
    blessed: 0,
    combo: [] as string[],
    retry: new Map<string, number>()
  };
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
      (memory.retry.get(name) ?? 0) <= Date.now() &&
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
  let ally = !choice && hits >= status().maxHits * 0.6 ? allyUnderPressure(session) : undefined;
  if (ally) {
    choice =
      (ally.flags ?? 0) & 4
        ? pick('Cure')
        : (ally.hits ?? 0) / (ally.maxHits ?? 1) < 0.35
          ? pick('Heal')
          : pick('Greater Heal', 'Heal');
  }
  if (!choice) ally = undefined;
  if (!choice && offensive && (await summonTurn(ctx, opponent, usable, memory))) return true;
  if (!choice && offensive) {
    if (enemyCasting) choice = pick('Magic Arrow', 'Harm');
    else if (Date.now() - memory.blessed > 120_000 && usable('Bless')) {
      choice = 'Bless';
      self = true;
    } else if (memory.combo.length) choice = pick(memory.combo[0] ?? '');
    else if (!targetPoisoned && status().mana > 15) choice = pick('Poison');
    else if (status().mana > 60 && usable('Explosion')) {
      choice = 'Explosion';
    } else choice = pick('Energy Bolt', 'Lightning', 'Fireball', 'Magic Arrow');
  }
  if (!choice) return false;
  const target = self ? { serial: ctx.serial, graphic: 0 } : (ally ?? opponent);
  const spell = byName.get(choice);
  if (!spell) return false;
  const outcome = await requestSpell(ctx, spell, target, memory.missing);
  memory.retry.set(choice, Date.now() + (outcome === 'unknown' ? (choice === 'Bless' ? 30_000 : 5000) : 1000));
  if (outcome === 'confirmed') {
    if (ally && !self) {
      rememberPartner(ctx.checkpoint, {
        partner: ally.serial,
        name: ally.name ?? 'companion',
        kind: 'support',
        result: 'completed',
        detail: `Helped my companion with ${choice}`,
        id: `support:${ally.serial}:${Math.floor(Date.now() / 30_000)}`
      });
      ctx.persist();
    }
    if (choice === 'Bless') memory.blessed = Date.now();
    if (choice === 'Explosion') memory.combo = [usable('Flame Strike') ? 'Flame Strike' : 'Energy Bolt'];
    else if (memory.combo[0] === choice) memory.combo.shift();
  } else memory.combo = [];
  return true;
}

async function summonTurn(
  ctx: FighterContext,
  opponent: Entity,
  usable: (name: string) => boolean,
  memory: { missing: Set<number>; retry: Map<string, number>; summoned?: { serial?: number; until: number } }
): Promise<boolean> {
  const { session, status } = ctx;
  if ((memory.summoned?.until ?? 0) > Date.now()) return false;
  const followers = status().followers ?? 0;
  if (followers >= (status().maxFollowers ?? 0) - 1 || status().mana < 60) return false;
  const here = ctx.position();
  const before = new Set([...session.world.entities.values()].filter((m) => m.kind === 'mobile').map((m) => m.serial));
  const tame = controlled.find(usable);
  if (tame) {
    const spell = byName.get(tame);
    if (!spell) return false;
    const outcome = await requestSpell(ctx, spell, null, memory.missing);
    memory.retry.set(tame, Date.now() + (outcome === 'confirmed' ? 60_000 : 10_000));
    if (outcome !== 'confirmed') return true;
    memory.summoned = { until: Date.now() + 60_000 };
    const candidates = [...session.world.entities.values()].filter(
      (mobile) =>
        mobile.kind === 'mobile' &&
        !before.has(mobile.serial) &&
        mobile.position &&
        distance(here, mobile.position) <= 3
    );
    for (const mobile of candidates) {
      ctx.check();
      const order = (await session.context(mobile.serial).catch(() => [])).find(
        (entry) => entry.cliloc === 3006111 && !(entry.flags & 1)
      );
      if (!order) continue;
      memory.summoned.serial = mobile.serial;
      session.selectContext(mobile.serial, order.index);
      await session.waitFor(() => session.world.target !== null, 'summon attack cursor', 2000).catch(() => {});
      ctx.check();
      if (session.world.target)
        session.target({ serial: opponent.serial, x: 0, y: 0, z: 0, graphic: opponent.graphic });
      break;
    }
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
  const wildSpell = byName.get(wildOne);
  if (friendly || !wildSpell) return false;
  const outcome = await requestSpell(ctx, wildSpell, spot, memory.missing);
  memory.retry.set(wildOne, Date.now() + (outcome === 'confirmed' ? 60_000 : 10_000));
  if (outcome === 'confirmed') memory.summoned = { until: Date.now() + 60_000 };
  return true;
}

// Reagents a caster keeps for combat, as restock targets.
export const combatReagents = Object.values(reagentGraphics);
