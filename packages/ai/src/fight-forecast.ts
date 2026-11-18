import { bandage, healPotion } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import { hostileNotoriety } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { type Monster, monsters } from './monster-reference';
import { familyOf, meleeWeapons, rangedWeapon, shootingWindow } from './weapons';

// ServUO creatures notice a fight within their perception range: 10 tiles for nearly every
// monster (the BaseCreature constructor's rangePerception).
export const PERCEPTION = 10;

const WAR_MODE = 0x40;
const RANGED_AI = new Set(['Archer', 'Mage', 'NecroMage', 'Necro', 'Spellweaving', 'Mystic', 'OrcScout']);
const CASTERS = new Set(['Mage', 'NecroMage', 'Spellbinder', 'Spellweaving', 'Mystic', 'Necro']);
const castsSpells = (stats: Monster) => CASTERS.has(stats.ai ?? '') || stats.magery > 0;
const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const skill = (session: PlayerSession, name: string) => session.world.skills.get(skillId(name))?.value ?? 0;
const carried = (session: PlayerSession) => {
  const pack = session.world
    .childrenOf(session.world.serial ?? -1)
    .find((item) => item.layer === Layer.Backpack)?.serial;
  const inside = (container: number): Entity[] =>
    session.world.childrenOf(container).flatMap((item) => [item, ...inside(item.serial)]);
  return pack === undefined ? [] : inside(pack);
};

export const statsOf = (mobile: Entity): Monster | undefined =>
  monsters.find(
    (m) =>
      m.bodies.includes(mobile.graphic) && (!mobile.name || (m.name ?? '').toLowerCase() === mobile.name.toLowerCase())
  ) ?? monsters.find((m) => m.bodies.includes(mobile.graphic));

// A creature that never starts a fight (ServUO: not aggressive, an animal's AI or no fight mode).
export const harmless = (mobile: Entity) => {
  const stats = statsOf(mobile);
  return !!stats && !stats.aggressive && (stats.ai === 'Animal' || stats.fightMode === 'None');
};

// Finish, step back to heal, or get away, by the resident's own risk tolerance: it fights on while
// finishing costs less than that share of the health it has now, and steps back to heal first when
// finishing would leave it below the share of its full health it will not risk, a heal fixes that,
// and the kill costs more than the pause. Otherwise it leaves.
export function compareCombatOptions(input: {
  hits: number;
  maxHits: number;
  incomingPerSecond: number;
  secondsToDefeat: number;
  healAmount?: number;
  healSeconds?: number;
  potionAmount?: number;
  escapeSeconds?: number;
  escapeExposure?: number;
  riskTolerance?: number;
}) {
  const health = Math.max(0, input.hits + (input.potionAmount ?? 0));
  const pressure = Math.max(0, input.incomingPerSecond);
  const exposure = input.escapeExposure ?? 0.25;
  const escapeSeconds = input.escapeSeconds ?? 3;
  const healSeconds = input.healSeconds ?? 8;
  const tolerance = input.riskTolerance ?? 0.5;
  const reserve = input.maxHits * (1 - tolerance);
  const fightLoss = pressure * input.secondsToDefeat;
  const escapeLoss = pressure * escapeSeconds * exposure;
  const withdrawalLoss = pressure * Math.max(escapeSeconds, healSeconds) * exposure;
  const restored = Math.min(input.maxHits, health - withdrawalLoss + (input.healAmount ?? 0));
  const healing = (input.healAmount ?? 0) > withdrawalLoss;
  const finish = fightLoss < health * tolerance;
  const heal =
    healing && health - fightLoss < reserve && fightLoss > withdrawalLoss && fightLoss < restored * tolerance;
  const action = heal ? ('bandage-break' as const) : finish ? ('press-attack' as const) : ('flee-town' as const);
  return {
    action,
    attack: fightLoss,
    recover: healing ? withdrawalLoss + fightLoss : Infinity,
    escape: escapeLoss,
    fightLoss,
    withdrawalLoss,
    secondsToDefeat: input.secondsToDefeat
  };
}

const average = (range: readonly number[] | null | undefined, fallback: number) =>
  range?.length ? range.reduce((sum, n) => sum + n, 0) / range.length : fallback;
// ServUO's hit chance: (skill + 20) over twice the defender's + 20.
const chance = (a: number, d: number) => Math.min(1, Math.max(0, (a + 20) / (2 * (d + 20))));
const exchanges = new WeakMap<
  PlayerSession,
  { serial: number; hits?: number; lastDamageAt: number; progressAt: number }
>();

// One fight with `target` as ServUO plays it: its health against the blows of everything in it,
// damage seen dealt and taken weighing more the more recent it is.
export function forecastFight(
  session: PlayerSession,
  target: Entity,
  options: {
    status?: { hits: number; maxHits: number; armor?: number };
    stats?: Monster;
    weapon?: Entity;
    opponents?: { mobile: Entity; weight: number }[];
    party?: number;
    caution?: number;
    riskTolerance?: number;
    potionReady?: boolean;
    casting?: boolean;
  } = {}
) {
  const world = session.world;
  const status = options.status ?? world.status ?? { hits: 0, maxHits: 0 };
  const inventory = carried(session);
  const count = (graphic: number) =>
    inventory.filter((item) => item.graphic === graphic).reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const equipped =
    options.weapon ??
    world
      .childrenOf(world.serial ?? -1)
      .find(
        (item) =>
          (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded) &&
          (meleeWeapons.has(item.graphic) || rangedWeapon(item.graphic))
      );
  const bow = rangedWeapon(equipped?.graphic);
  const weapon = bow && !count(bow.ammo) ? undefined : equipped;
  const ownSkill = weapon ? skill(session, bow ? 'Archery' : familyOf(weapon.graphic)) : skill(session, 'Wrestling');
  const stats = options.stats ?? statsOf(target);
  const catalogHits = average(stats?.hits, status.maxHits);
  const fraction = target.hits !== undefined && target.maxHits ? target.hits / target.maxHits : 1;
  const remaining = Math.max(0, catalogHits * fraction);
  const tactics = skill(session, 'Tactics');
  const weaponDamage = weapon ? 8 + tactics / 10 : 2 + tactics / 40;
  const observed = world.damage?.get(target.serial);
  const observedWeight = observed ? Math.exp(-Math.max(0, Date.now() - observed.at) / 8000) : 0;
  const perHit = weaponDamage * (1 - observedWeight) + (observed?.amount ?? weaponDamage) * observedWeight;
  const mana = world.status?.mana ?? 0;
  let outgoing =
    options.casting && mana > 0
      ? (skill(session, 'Magery') * 0.12 * (1 + skill(session, 'EvalInt') / 100) * mana) / (mana + 10)
      : (perHit * chance(ownSkill, stats?.wrestling ?? 50)) /
        (bow ? shootingWindow(bow, world.status?.stamina ?? 100) / 1000 : 2);
  if (!world.warMode) exchanges.delete(session);
  if (world.warMode && world.combatant === target.serial) {
    const now = Date.now();
    let exchange = exchanges.get(session);
    if (!exchange || exchange.serial !== target.serial) {
      exchange = { serial: target.serial, hits: target.hits, lastDamageAt: observed?.at ?? 0, progressAt: now };
      exchanges.set(session, exchange);
    }
    if (
      (target.hits !== undefined && exchange.hits !== undefined && target.hits < exchange.hits) ||
      (observed?.at ?? 0) > exchange.lastDamageAt
    )
      exchange.progressAt = now;
    exchange.hits = target.hits;
    exchange.lastDamageAt = observed?.at ?? 0;
    outgoing /= 1 + Math.max(0, now - exchange.progressAt) / 2000;
  }
  const approach =
    target.position && world.position ? Math.max(0, away(target.position, world.position) - 1) * 0.22 : 0;
  const attackSeconds = bow ? shootingWindow(bow, world.status?.stamina ?? 100) / 1000 : 2;
  const oneSuccessfulAttack = options.casting
    ? 1.5
    : attackSeconds / Math.max(Number.EPSILON, chance(ownSkill, stats?.wrestling ?? 50));
  const secondsToDefeat = approach + Math.max(oneSuccessfulAttack, remaining / Math.max(Number.EPSILON, outgoing));
  const opponents = options.opponents ?? [{ mobile: target, weight: 1 }];
  const modelPressure =
    opponents.reduce((sum, { mobile, weight }) => {
      const monster = mobile.serial === target.serial ? stats : statsOf(mobile);
      const melee =
        (average(monster?.damage, 10) * chance(monster?.wrestling ?? 50, ownSkill)) /
        2 /
        (1 + (status.armor ?? 0) / 100);
      const spells =
        monster && castsSpells(monster) ? ((monster.magery / 100) * 8) / (1 + skill(session, 'MagicResist') / 100) : 0;
      const poison = (monster?.poison ?? 0) + (monster && castsSpells(monster) ? monster.magery / 100 : 0);
      return sum + weight * (melee + spells + poison);
    }, 0) / Math.max(1, options.party ?? 1);
  const changes = (world.healthChanges ?? []).filter((change) => change.at <= Date.now() && change.damage > 0);
  const weight = changes.reduce((sum, change) => sum + Math.exp(-(Date.now() - change.at) / 8000), 0);
  const damage = changes.reduce((sum, change) => sum + change.damage * Math.exp(-(Date.now() - change.at) / 8000), 0);
  const observedPressure = damage / 4;
  const incomingPerSecond =
    ((modelPressure + observedPressure * weight) / (1 + weight)) * (1 + (options.caution ?? 0)) +
    (world.poisonLevel ?? 0);
  const healing = skill(session, 'Healing');
  const healAmount =
    Math.min(count(bandage), 1) * (10 + healing / 3 + skill(session, 'Anatomy') / 5) * (healing / (healing + 50));
  const potionAmount =
    options.potionReady && count(healPotion) && !(world.poisonLevel ?? 0)
      ? Math.min(status.maxHits - status.hits, 20)
      : 0;
  const projection = {
    hits: status.hits,
    maxHits: status.maxHits,
    incomingPerSecond,
    secondsToDefeat,
    healAmount,
    potionAmount,
    escapeExposure: stats && castsSpells(stats) ? 0.7 : 0.25,
    riskTolerance: options.riskTolerance
  };
  const withoutPotion = compareCombatOptions({ ...projection, potionAmount: 0 });
  const withPotion = compareCombatOptions(projection);
  // A potion is worth drinking when it turns a fight it would leave into one it finishes.
  const usePotion = withoutPotion.action !== 'press-attack' && withPotion.action === 'press-attack';
  const comparison = usePotion ? withPotion : withoutPotion;
  return {
    ...comparison,
    remaining,
    outgoingPerSecond: outgoing,
    incomingPerSecond,
    healAmount,
    potionAmount: usePotion ? potionAmount : 0,
    predictedLoss: comparison.fightLoss / Math.max(1, status.maxHits),
    healthRatio: status.hits / Math.max(1, status.maxHits)
  };
}

// What it is right now, from its client: health, the weapon in its hands and the best one in its
// pack, and who is fighting it.
export interface SelfState {
  hits: number;
  maxHits: number;
  dead: boolean;
  held?: Entity;
  spare?: Entity;
  attackers: Entity[];
}

// Old-style (0x6E) swing and cast actions (ServUO BaseWeapon.PlaySwingAnimation, Spell casting):
// a creature's 4-6, a person's 9-14 on foot and 26-29 mounted, and 16-17 casting.
const OLD_ATTACK_ACTIONS = new Set([4, 5, 6, 9, 10, 11, 12, 13, 14, 16, 17, 26, 27, 28, 29]);
const ATTACK = 0;
const SPELL = 11;
// The UO direction (0 north, clockwise to 7 north-west) from `from` towards `to`.
const directionTo = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  return [7, 0, 1, 6, -1, 2, 5, 4, 3][(dy + 1) * 3 + (dx + 1)] ?? -1;
};
// An attack or a spell animated in the last three seconds by a mobile facing it (one direction of
// slack either side), within melee reach, or within twelve tiles for a shot or a spell.
function attackingAt(
  seen: { type: number | null; action: number; at: number } | undefined,
  from: { x: number; y: number; direction?: number },
  at: { x: number; y: number },
  distance: number
) {
  if (!seen || Date.now() - seen.at >= 3000 || distance > 12) return false;
  const attack = seen.type === null ? OLD_ATTACK_ACTIONS.has(seen.action) : seen.type === ATTACK || seen.type === SPELL;
  if (!attack) return false;
  const facing = directionTo(from, at);
  const turn = Math.abs(((from.direction ?? 0) & 7) - facing);
  return facing >= 0 && (turn <= 1 || turn === 7);
}

export function selfState(session: PlayerSession, ghost: boolean): SelfState {
  const world = session.world;
  const me = world.serial ?? -1;
  const worn = world.childrenOf(me);
  const held = worn.find(
    (item) => (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded) && meleeWeapons.has(item.graphic)
  );
  // The best weapon it could take out of its pack: the one of the family it is most skilled in.
  const spare = carried(session)
    .filter((item) => meleeWeapons.has(item.graphic))
    .sort((a, b) => skill(session, familyOf(b.graphic)) - skill(session, familyOf(a.graphic)))[0];
  const here = world.position;
  // Who is fighting it. The swing packet (0x2F) reaches the attacker alone; a defender sees the
  // attacker's animation, sent to every client in view (ServUO Mobile.Animate: 0xE2 Attack or Spell,
  // 0x6E before SA), with the attacker turned to face it. So: one animating an attack or a spell at
  // it in the last three seconds, within reach; else a hostile creature in war mode (mobile flag
  // 0x40) within its reach, for an animation missed. A creature that never starts a fight is not one.
  const attackers = [...world.entities.values()].filter((mobile) => {
    if (mobile.kind !== 'mobile' || mobile.serial === me || world.deaths.has(mobile.serial)) return false;
    if (!mobile.position || !here) return false;
    const distance = away(here, mobile.position);
    const swing = world.swings.get(mobile.serial);
    if (swing?.target === me && Date.now() - swing.at < 3000 && distance <= 12) return true;
    if (attackingAt(world.animations.get(mobile.serial), mobile.position, here, distance)) return true;
    if (!((mobile.flags ?? 0) & WAR_MODE) || !hostileNotoriety.includes(mobile.notoriety ?? 0) || harmless(mobile))
      return false;
    const stats = statsOf(mobile);
    const reach = stats && (castsSpells(stats) || RANGED_AI.has(stats.ai ?? '')) ? 10 : 2;
    return distance <= reach;
  });
  const status = world.status;
  return { hits: status?.hits ?? 0, maxHits: status?.maxHits ?? 0, dead: ghost, held, spare, attackers };
}

// How it weighs a fight: allies sharing it, wariness, its nerve, and the creatures it sees.
export interface Judgement {
  party?: number;
  caution?: number;
  riskTolerance?: number;
  casting?: boolean;
  seen?: Entity[];
  // Whether a hostile creature about the target would join in; by default, any that is not harmless.
  joins?: (mobile: Entity) => boolean;
}

// Everyone a fight with `target` brings: what attacks it already, the target, and every hostile
// creature in sight close enough to the target to notice.
export function fightGroup(
  session: PlayerSession,
  self: SelfState,
  target?: Entity,
  seen: Entity[] = [...session.world.entities.values()].filter((e) => e.kind === 'mobile'),
  joins: (mobile: Entity) => boolean = (mobile) => !harmless(mobile)
): Entity[] {
  const group = new Map(self.attackers.map((mobile) => [mobile.serial, mobile]));
  if (target) group.set(target.serial, target);
  const at = target?.position;
  if (at)
    for (const mobile of seen)
      if (
        mobile.serial !== session.world.serial &&
        mobile.position &&
        away(mobile.position, at) <= PERCEPTION &&
        hostileNotoriety.includes(mobile.notoriety ?? 0) &&
        !session.world.deaths.has(mobile.serial) &&
        joins(mobile)
      )
        group.set(mobile.serial, mobile);
  return [...group.values()];
}

// The whole fight played out: it takes on `target` (else the quickest kill) first, then the next
// quickest while the rest keep hitting, its health falling by each fight's loss. The first opponent
// when it would stay in every exchange rather than run, else nothing (flee).
export function encounterTarget(
  session: PlayerSession,
  self: SelfState,
  target?: Entity,
  judgement: Judgement = {}
): Entity | undefined {
  if (self.dead) return undefined;
  const { seen, joins, ...weighing } = judgement;
  let remaining = fightGroup(session, self, target, seen, joins);
  let hits = self.hits;
  let first: Entity | undefined;
  while (remaining.length) {
    const opponents = remaining.map((mobile) => ({ mobile, weight: 1 }));
    const forecast = (mobile: Entity) =>
      forecastFight(session, mobile, {
        ...weighing,
        status: { hits, maxHits: self.maxHits, armor: session.world.status?.armor },
        weapon: self.held ?? self.spare,
        opponents
      });
    const next =
      first === undefined && target
        ? { mobile: target, forecast: forecast(target) }
        : remaining
            .map((mobile) => ({ mobile, forecast: forecast(mobile) }))
            .sort((a, b) => a.forecast.secondsToDefeat - b.forecast.secondsToDefeat)[0];
    if (!next || next.forecast.action === 'flee-town') return undefined;
    first ??= next.mobile;
    hits -= next.forecast.fightLoss;
    remaining = remaining.filter((mobile) => mobile.serial !== next.mobile.serial);
  }
  return first;
}

export const canBeat = (session: PlayerSession, self: SelfState, target: Entity, judgement?: Judgement) =>
  !!encounterTarget(session, self, target, judgement);
