import { bandage, healPotion } from '@gemwright/common/game/items';
import { skillId } from '@gemwright/common/game/skills';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { compareCombatOptions } from './combat-options';
import { castsSpells } from './creature-risk';
import { familyOf, meleeWeapons } from './fighter-context';
import { packItems } from './inventory';
import { type Monster, monsters } from './monster-reference';
import { rangedWeapon, shootingWindow } from './ranged-weapons';

export const creatureOf = (mobile: Entity) =>
  monsters.find((m) => m.bodies.includes(mobile.graphic) && m.name?.toLowerCase() === mobile.name?.toLowerCase()) ??
  monsters.find((m) => m.bodies.includes(mobile.graphic));
const exchanges = new WeakMap<
  PlayerSession,
  { serial: number; hits?: number; lastDamageAt: number; progressAt: number }
>();
const average = (range: readonly number[] | null | undefined, fallback: number) =>
  range?.length ? range.reduce((sum, n) => sum + n, 0) / range.length : fallback;
const chance = (a: number, d: number) => Math.min(1, Math.max(0, (a + 20) / (2 * (d + 20))));

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
  const skill = (name: string) => session.world.skills.get(skillId(name))?.value ?? 0;
  const status = options.status ?? session.world.status ?? { hits: 0, maxHits: 0 };
  const worn = session.world.childrenOf(session.world.serial ?? -1);
  const pack = worn.find((item) => item.layer === 21);
  const inventory = pack ? packItems(session, pack.serial) : [];
  const count = (graphic: number) =>
    inventory.filter((item) => item.graphic === graphic).reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const equipped =
    options.weapon ??
    worn.find(
      (item) => (item.layer === 1 || item.layer === 2) && (meleeWeapons.has(item.graphic) || rangedWeapon(item.graphic))
    );
  const bow = rangedWeapon(equipped?.graphic);
  const weapon = bow && !count(bow.ammo) ? undefined : equipped;
  const ownSkill = weapon ? skill(bow ? 'Archery' : familyOf(weapon.graphic)) : skill('Wrestling');
  const stats = options.stats ?? creatureOf(target);
  const catalogHits = average(stats?.hits, status.maxHits);
  const fraction = target.hits !== undefined && target.maxHits ? target.hits / target.maxHits : 1;
  const remaining = Math.max(0, catalogHits * fraction);
  const weaponDamage = weapon ? 8 + skill('Tactics') / 10 : 2 + skill('Tactics') / 40;
  const observed = session.world.damage?.get(target.serial);
  const observedWeight = observed ? Math.exp(-Math.max(0, Date.now() - observed.at) / 8000) : 0;
  const perHit = weaponDamage * (1 - observedWeight) + (observed?.amount ?? weaponDamage) * observedWeight;
  let outgoing =
    options.casting && (session.world.status?.mana ?? 0) > 0
      ? (skill('Magery') * 0.12 * (1 + skill('EvalInt') / 100) * (session.world.status?.mana ?? 0)) /
        ((session.world.status?.mana ?? 0) + 10)
      : (perHit * chance(ownSkill, stats?.wrestling ?? 50)) /
        (bow ? shootingWindow(bow, session.world.status?.stamina ?? 100) / 1000 : 2);
  if (!session.world.warMode) exchanges.delete(session);
  if (session.world.warMode && session.world.combatant === target.serial) {
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
    target.position && session.world.position
      ? Math.max(
          0,
          Math.max(
            Math.abs(target.position.x - session.world.position.x),
            Math.abs(target.position.y - session.world.position.y)
          ) - 1
        ) * 0.22
      : 0;
  const attackSeconds = bow ? shootingWindow(bow, session.world.status?.stamina ?? 100) / 1000 : 2;
  const oneSuccessfulAttack = options.casting
    ? 1.5
    : attackSeconds / Math.max(Number.EPSILON, chance(ownSkill, stats?.wrestling ?? 50));
  const secondsToDefeat = approach + Math.max(oneSuccessfulAttack, remaining / Math.max(Number.EPSILON, outgoing));
  const opponents = options.opponents ?? [{ mobile: target, weight: 1 }];
  const modelPressure =
    opponents.reduce((sum, { mobile, weight }) => {
      const monster = mobile.serial === target.serial ? stats : creatureOf(mobile);
      const melee =
        (average(monster?.damage, 10) * chance(monster?.wrestling ?? 50, ownSkill)) /
        2 /
        (1 + (status.armor ?? 0) / 100);
      const spells =
        monster && castsSpells(monster) ? ((monster.magery / 100) * 8) / (1 + skill('MagicResist') / 100) : 0;
      const poison = (monster?.poison ?? 0) + (monster && castsSpells(monster) ? monster.magery / 100 : 0);
      return sum + weight * (melee + spells + poison);
    }, 0) / Math.max(1, options.party ?? 1);
  const changes = (session.world.healthChanges ?? []).filter((change) => change.at <= Date.now() && change.damage > 0);
  const weight = changes.reduce((sum, change) => sum + Math.exp(-(Date.now() - change.at) / 8000), 0);
  const damage = changes.reduce((sum, change) => sum + change.damage * Math.exp(-(Date.now() - change.at) / 8000), 0);
  const observedPressure = damage / 4;
  const incomingPerSecond =
    ((modelPressure + observedPressure * weight) / (1 + weight)) * (1 + (options.caution ?? 0)) +
    (session.world.poisonLevel ?? 0);
  const healingChance = skill('Healing') / (skill('Healing') + 50);
  const healAmount = Math.min(count(bandage), 1) * (10 + skill('Healing') / 3 + skill('Anatomy') / 5) * healingChance;
  const potionAmount =
    options.potionReady && count(healPotion) && !(session.world.poisonLevel ?? 0)
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
