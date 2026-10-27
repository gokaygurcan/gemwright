import { skillId } from '@gemwright/common/skills';

import { type Monster, monsters } from './dungeons';
import { fightConfidence } from './fight-confidence';
import { bandage, type FighterContext, familyOf, healPotion, meleeWeapons, weaponSkill } from './fighter-context';
import { alliesNear } from './hunting-party';
import { distance } from './navigation';
import { Layer } from './protocol/layers';
import type { Entity } from './protocol/world';
import { equippedRanged } from './ranged-weapons';

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

// Dungeon creatures (catalogs/monsters.json) get the same tiers from their ServUO stats, calibrated
// on the undead above: a zombie is common, a ghoul a brute, a spectre a caster, a bone knight or
// mummy a knight, a lich a lich. Creatures with unknown stats, very high health or resist, or human
// bodies (players and brigands look alike) are never engaged. Random-named kinds (orcs, ratmen)
// match on body alone.
const humanBodies = [0x190, 0x191];
// Creatures that do not attack on sight (deer, horses, cats) are no one's opponents.
const tierOf = (m: Monster): Tier => {
  if (!m.hits || !m.damage || m.aggressive === false || humanBodies.some((body) => m.bodies.includes(body)))
    return 'unsupported';
  const hits = ((m.hits[0] ?? 0) + (m.hits[1] ?? 0)) / 2;
  const damage = ((m.damage[0] ?? 0) + (m.damage[1] ?? 0)) / 2;
  if (hits > 330 || m.resist >= 150 || m.fame >= 15000) return 'unsupported';
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
// sight, in a dungeon or overland (catalogs/monsters.json covers both; hunting-grounds.json says
// where they spawn).
export const prey = new Set([...graveyard, ...dungeonPrey]);
export const recognised = (graphic: number) => prey.has(graphic);

// Whether this character's skills, health and armour meet a creature kind's tier (catalog type),
// leaving out the moment's health and supplies: used to choose where to hunt (cemeteries.ts).
export function readyFor(ctx: FighterContext, type: string, group = 1): boolean {
  const monster = monsters.find((m) => m.type === type);
  if (!monster) return false;
  const tier = tierOf(monster);
  if (tier === 'unsupported') return false;
  if (tier === 'common') return fightCost(ctx, type, group) <= 0.5;
  const scale = (group >= 3 && ['brute', 'caster'].includes(tier)) || (group >= 4 && tier === 'knight') ? 0.6 : 1;
  const [weapon, tactics, maxHits, armor] = requirements[tier].map((value) => value * scale);
  const combat = ctx.template.archetype?.primarySkills.includes('Magery') ? 'Magery' : weaponSkill(ctx.template);
  const skill = (name: string) => ctx.session.world.skills.get(skillId(name))?.value ?? 0;
  const status = ctx.status();
  return (
    fightCost(ctx, type, group) <= 0.5 &&
    skill(combat) >= (weapon ?? 0) &&
    skill('Tactics') >= (tactics ?? 0) &&
    status.maxHits >= (maxHits ?? 0) &&
    status.armor >= (armor ?? 0)
  );
}
// A fight against one creature of a kind, estimated with ServUO's hit chance ((attacker skill + 20)
// over twice (defender skill + 20)), equal swing rates and the character's typical damage per hit
// (8 plus a tenth of Tactics; spells for mages): the share of the character's maximum health it
// loses before the creature dies, without healing. Over half is a fight not worth picking; a
// group splits the damage.
const ranged = (ctx: FighterContext) => !!equippedRanged(ctx.session);

export function fightCost(ctx: FighterContext, type: string, group = 1): number {
  const monster = monsters.find((m) => m.type === type);
  if (!monster?.hits || !monster.damage) return Infinity;
  const skill = (name: string) => ctx.session.world.skills.get(skillId(name))?.value ?? 0;
  // What it really fights with (self.ts, read live): the weapon in hand and its skill, or fists.
  const held = ctx.session.world
    .childrenOf(ctx.serial)
    .find((i) => (i.layer === Layer.OneHanded || i.layer === Layer.TwoHanded) && meleeWeapons.has(i.graphic));
  const caster = ctx.template.archetype?.primarySkills.includes('Magery');
  const own = caster ? combatSkill(ctx) : skill(familyOf(held?.graphic));
  const theirs = monster.wrestling ?? 50;
  const hits = ((monster.hits[0] ?? 0) + (monster.hits[1] ?? 0)) / 2;
  const damage = ((monster.damage[0] ?? 0) + (monster.damage[1] ?? 0)) / 2;
  const hitChance = (attacker: number, defender: number) =>
    Math.min(1, Math.max(0.02, (attacker + 20) / (2 * (defender + 20))));
  // A weapon lands about 8 a swing (more with Tactics); fists about 2 (ServUO's 1-4 unarmed).
  const perSwing = held || caster || ranged(ctx) ? 8 + skill('Tactics') / 10 : 2 + skill('Tactics') / 40;
  const swings = hits / perSwing / hitChance(own, theirs);
  // Armour takes part of each blow (the status armour rating, at most 60%).
  const armour = 1 - Math.min(0.6, (ctx.status().armor ?? 0) / 100);
  const taken = (swings * hitChance(theirs, own) * damage * armour) / Math.max(1, group);
  return taken / Math.max(1, ctx.status().maxHits);
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

// Minimum character readiness per tier: weapon skill, tactics, maximum health, armor rating,
// current health ratio, and the template's risk tolerance. Common undead are always allowed.
const requirements: Record<Exclude<Tier, 'common' | 'unsupported'>, number[]> = {
  //       swords tactics maxHits armor health risk
  brute: [45, 40, 60, 0, 0.8, 0.2],
  // At swords 60, tactics 55, healing 12-33 and no magic resist, spectres and wraiths deal 24-26
  // point spell hits and force emergency escapes: casters need resist and reliable healing.
  caster: [70, 65, 85, 15, 0.9, 0.3],
  knight: [80, 80, 90, 20, 0.9, 0.5],
  lich: [95, 95, 110, 40, 0.95, 0.7]
};

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
  const near = ctx
    .nearby()
    .filter((other) => other.serial !== mobile.serial && other.position && mobile.position)
    .filter((other) => distance(other.position ?? ctx.position(), mobile.position ?? ctx.position()) <= 12);
  const menace = near.find((other) => ['lich', 'unsupported', 'knight'].includes(profileOf(other)?.tier ?? ''));
  if (menace && profile.tier !== profileOf(menace)?.tier)
    return { ok: false, reason: `${menace.name} nearby (${profileOf(menace)?.note})` };
  // Every fight, common ones too, is sized up first: the target and whatever would join in.
  const sized = fightConfidence(ctx, mobile);
  if (!sized.ok) return { ok: false, reason: `${mobile.name} too risky: ${sized.reason}` };
  if (profile.tier === 'common') return { ok: true, reason: profile.note };
  if (profile.tier === 'unsupported') return { ok: false, reason: `${mobile.name}: ${profile.note}` };
  // A hunting party of three takes on casters and brutes, four also knights: thresholds drop to
  // 60% and the solo-only rules (resist, healing skill, risk, no other undead nearby) are waived.
  const group = alliesNear(ctx, mobile.position ?? ctx.position()).length + 1;
  const together =
    (group >= 3 && ['brute', 'caster'].includes(profile.tier)) || (group >= 4 && profile.tier === 'knight');
  const scale = together ? 0.6 : 1;
  const [weapon, tactics, maxHits, armor, health, risk] = requirements[profile.tier].map((value, index) =>
    index < 4 ? value * scale : value
  );
  // Casters are judged by their Magery; everyone else by their weapon skill.
  const combat = ctx.template.archetype?.primarySkills.includes('Magery') ? 'Magery' : weaponSkill(ctx.template);
  const skill = (name: string) => ctx.session.world.skills.get(skillId(name))?.value ?? 0;
  const status = ctx.status();
  const shortfalls = [
    skill(combat) < (weapon ?? 0) && `${combat.toLowerCase()} ${skill(combat)}/${weapon}`,
    skill('Tactics') < (tactics ?? 0) && `tactics ${skill('Tactics')}/${tactics}`,
    status.maxHits < (maxHits ?? 0) && `max health ${status.maxHits}/${maxHits}`,
    status.armor < (armor ?? 0) && `armor ${status.armor}/${armor}`,
    status.hits < status.maxHits * (health ?? 1) && `health ${status.hits}/${status.maxHits}`,
    !together && ctx.template.behavior.riskTolerance < (risk ?? 1) && 'template risk tolerance',
    ctx.count(bandage) < 10 && ctx.count(healPotion) < 2 && 'healing supplies',
    // Spells ignore armor: casters and liches need resistance and reliable bandaging.
    !together &&
      ['caster', 'lich'].includes(profile.tier) &&
      skill('MagicResist') < (profile.tier === 'lich' ? 80 : 40) &&
      `magic resist ${skill('MagicResist')}/${profile.tier === 'lich' ? 80 : 40}`,
    !together && ['caster', 'lich'].includes(profile.tier) && skill('Healing') < 50 && `healing ${skill('Healing')}/50`,
    // Casters and stronger creatures are fought one at a time.
    !together &&
      near.some(
        (other) =>
          recognised(other.graphic) && distance(other.position ?? ctx.position(), mobile.position ?? ctx.position()) < 6
      ) &&
      'other creatures within 6 tiles'
  ].filter(Boolean);
  return shortfalls.length
    ? { ok: false, reason: `${mobile.name} (${profile.tier}) needs ${shortfalls.join(', ')}` }
    : { ok: true, reason: `${mobile.name}: ${profile.note}` };
}
