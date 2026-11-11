import { PLAIN_HUMAN_BODIES } from '@gemwright/common/game/bodies';
import { skillId } from '@gemwright/common/game/skills';
import type { Entity } from '@gemwright/network/world';

import { type Monster, monsters } from '../monster-reference';
import { forecastFight } from './combat-forecast';
import { fightConfidence } from './fight-confidence';
import { type FighterContext, weaponSkill } from './fighter-context';

// Graveyard undead on the pinned ServUO shard (Scripts/Mobiles/Normal). Names come from the
// ordinary single-click label; several share a body, so the body only narrows the candidates.
type Tier = 'common' | 'brute' | 'caster' | 'knight' | 'lich' | 'unsupported';
const profiles: { name: RegExp; bodies: number[]; tier: Tier; note: string }[] = [
  { name: /^a zombie$/i, bodies: [3], tier: 'common', note: '28-42 hp, 3-7 melee' },
  { name: /^a skeleton$/i, bodies: [50, 56], tier: 'common', note: '34-48 hp, 3-7 melee' },
  { name: /^a ghoul$/i, bodies: [153], tier: 'brute', note: '46-60 hp, 7-9 melee' },
  { name: /^an? (spectre|wraith|shade|bogle)$/i, bodies: [26, 153], tier: 'caster', note: 'magery 55-70, 7-11 melee' },
  { name: /^a (skeletal mage|bone mage)$/i, bodies: [148], tier: 'caster', note: 'magery 60-70' },
  { name: /^a (bone|skeletal) knight$/i, bodies: [57, 147], tier: 'knight', note: '118-150 hp, tactics 85-100' },
  { name: /^a mummy$/i, bodies: [154], tier: 'knight', note: '208-222 hp, 13-23 melee' },
  { name: /^a lich$/i, bodies: [24], tier: 'lich', note: 'necromage, 103-120 hp, resist 80-100' },
  // Magic resist 150-200 and 250-303 hp: never a sensible target for an ordinary melee character.
  { name: /^a lich lord$/i, bodies: [79], tier: 'unsupported', note: 'necromage, resist 150-200' }
];
const graveyard = profiles.flatMap((profile) => profile.bodies);

// Dungeon creatures (the creature rules) get the same tiers from their ServUO stats, calibrated
// on the undead above: a zombie is common, a ghoul a brute, a spectre a caster, a bone knight or
// mummy a knight, a lich a lich. Creatures with unknown stats, very high health or resist, or human
// bodies (players and brigands look alike) are never engaged. Random-named kinds (orcs, ratmen)
// match on body alone.
const humanBodies = [...PLAIN_HUMAN_BODIES];
// Creatures that do not attack on sight (deer, horses, cats) are no one's opponents.
const tierOf = (m: Monster): Tier => {
  if (!m.hits || !m.damage || m.aggressive === false || humanBodies.some((body) => m.bodies.includes(body)))
    return 'unsupported';
  const hits = ((m.hits[0] ?? 0) + (m.hits[1] ?? 0)) / 2;
  const damage = ((m.damage[0] ?? 0) + (m.damage[1] ?? 0)) / 2;

  if (m.magery >= 80 && (hits >= 100 || damage >= 15)) return 'lich';
  if (m.magery > 0) return 'caster';
  if (hits >= 110 || damage >= 12) return 'knight';
  if (hits >= 45 || damage >= 8) return 'brute';
  return 'common';
};
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dungeonProfiles = monsters
  .filter((m) => m.bodies.length && !profiles.some((p) => p.name.test(m.name ?? '')))
  .map((m) => ({
    name: m.name ? new RegExp(`^${literal(m.name)}$`, 'i') : /./,
    bodies: m.bodies,
    tier: tierOf(m),
    note: `${m.hits?.join('-') ?? '?'} hp, ${m.damage?.join('-') ?? '?'} melee${m.magery ? `, magery ${m.magery}` : ''}`
  }));
export const dungeonPrey = new Set(dungeonProfiles.filter((p) => p.tier !== 'unsupported').flatMap((p) => p.bodies));
// Any creature a fighter may hunt: graveyard undead, and every other creature that attacks on
// sight, in a dungeon or overland (the creature rules cover both; the shard's spawners say
// where they spawn).
export const prey = new Set([...graveyard, ...dungeonPrey]);
export const recognised = (graphic: number) => prey.has(graphic);

// Whether this character's skills, health and armour meet a creature kind's tier (catalog type),
// leaving out the moment's health and supplies: used to choose where to hunt (cemeteries.ts).
export function readyFor(ctx: FighterContext, type: string, group = 1): boolean {
  const stats = monsters.find((monster) => monster.type === type);
  if (!stats?.aggressive) return false;
  return (
    forecastFight(
      ctx.session,
      { serial: -1, kind: 'mobile', graphic: stats.bodies[0] ?? 0, name: stats.name ?? undefined },
      { stats, status: ctx.status(), casting: ctx.template.archetype?.primarySkills.includes('Magery'), party: group }
    ).action !== 'flee-town'
  );
}

export function fightCost(ctx: FighterContext, type: string, group = 1): number {
  const stats = monsters.find((monster) => monster.type === type);
  if (!stats) return Infinity;
  return forecastFight(
    ctx.session,
    { serial: -1, kind: 'mobile', graphic: stats.bodies[0] ?? 0, name: stats.name ?? undefined },
    { stats, status: ctx.status(), casting: ctx.template.archetype?.primarySkills.includes('Magery'), party: group }
  ).predictedLoss;
}

// The skill a character fights with: Magery for mages, else its weapon skill.
export function combatSkill(ctx: FighterContext): number {
  const name = ctx.template.archetype?.primarySkills.includes('Magery') ? 'Magery' : weaponSkill(ctx.template);
  return ctx.session.world.skills.get(skillId(name))?.value ?? 0;
}

// Whether fighting a kind still teaches: ServUO gains come from fights that are neither sure nor
// hopeless, so the creature's skill should be near the character's (from 25 below to 15 above).
export function teaches(ctx: FighterContext, type: string): boolean {
  const theirs = monsters.find((m) => m.type === type)?.wrestling ?? 50;
  const own = combatSkill(ctx);
  return theirs >= own - 25 && theirs <= own + 15;
}

// The gold a kind's loot packs carry, for choosing grounds worth the walk.
export const goldOf = (type: string) => monsters.find((m) => m.type === type)?.gold ?? 0;

export const profileOf = (mobile: Entity) =>
  mobile.name
    ? (profiles.find((profile) => profile.name.test(mobile.name ?? '')) ??
      dungeonProfiles.find(
        (profile) => profile.bodies.includes(mobile.graphic) && profile.name.test(mobile.name ?? '')
      ))
    : undefined;

// A decision-facing label such as "a wraith (caster: magery 55-70, 7-11 melee)".
export const describe = (mobile: Entity) => {
  const profile = profileOf(mobile);
  return profile ? `${mobile.name} (${profile.tier}: ${profile.note})` : (mobile.name ?? 'undead');
};

// Whether this character should start a fight with an inspected undead mobile, with the reason
// when it should not. Dangerous undead nearby rule out even easy targets close to them.
export function engageable(ctx: FighterContext, mobile: Entity): { ok: boolean; reason: string } {
  const profile = profileOf(mobile);
  if (!profile?.bodies.includes(mobile.graphic)) return { ok: false, reason: 'not a recognised opponent' };
  if (profile.tier === 'unsupported') return { ok: false, reason: 'not an aggressive hunting opponent' };
  return fightConfidence(ctx, mobile);
}
