import { skillId } from '@gemwright/common/game/skills';
import { Layer } from '@gemwright/network/layers';
import { hostileNotoriety } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { forecastFight } from './combat-forecast';
import { castsSpells } from './creature-risk';
import { threatsNear } from './danger';
import { familyOf, meleeWeapons } from './fighter-context';
import { packItems } from './inventory';
import { type Monster, monsters } from './monster-reference';
import { distance } from './navigation';

const WAR_MODE = 0x40;
const RANGED_AI = new Set(['Archer', 'Mage', 'NecroMage', 'Necro', 'Spellweaving', 'Mystic', 'OrcScout']);

// What a resident is right now, read from its client's live state on every tick: health, the weapon
// in its hands and the best one in its pack, and who is hitting it. Every combat choice reads this
// one view (reflex.ts), and the recording keeps it each time it changes.
export interface SelfState {
  hits: number;
  maxHits: number;
  dead: boolean;
  held?: Entity;
  spare?: Entity;
  attackers: Entity[];
}

const skill = (session: PlayerSession, name: string) => session.world.skills.get(skillId(name))?.value ?? 0;

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
  away: number
) {
  if (!seen || Date.now() - seen.at >= 3000 || away > 12) return false;
  const attack = seen.type === null ? OLD_ATTACK_ACTIONS.has(seen.action) : seen.type === ATTACK || seen.type === SPELL;
  if (!attack) return false;
  const facing = directionTo(from, at);
  const turn = Math.abs(((from.direction ?? 0) & 7) - facing);
  return facing >= 0 && (turn <= 1 || turn === 7);
}

export function selfState(session: PlayerSession, ghost: boolean): SelfState {
  const me = session.world.serial ?? -1;
  const worn = session.world.childrenOf(me);
  const held = worn.find(
    (item) => (item.layer === Layer.OneHanded || item.layer === Layer.TwoHanded) && meleeWeapons.has(item.graphic)
  );
  const pack = worn.find((item) => item.layer === Layer.Backpack);
  // The best weapon it could take out of its pack: the one of the family it is most skilled in.
  const spare = (pack ? packItems(session, pack.serial) : [])
    .filter((item) => meleeWeapons.has(item.graphic))
    .sort((a, b) => skill(session, familyOf(b.graphic)) - skill(session, familyOf(a.graphic)))[0];
  const here = session.world.position;
  // Who is fighting it. The swing packet (0x2F) reaches the attacker alone; a defender sees the
  // attacker's animation, sent to every client in view (ServUO Mobile.Animate: 0xE2 Attack or Spell,
  // 0x6E before SA), with the attacker turned to face it. So: one animating an attack or a spell at
  // it in the last three seconds, within reach; else a hostile creature in war mode (mobile flag
  // 0x40) within its reach, for an animation missed. A creature that never starts a fight is not one.
  const attackers = [...session.world.entities.values()].filter((mobile) => {
    if (mobile.kind !== 'mobile' || mobile.serial === me || session.world.deaths.has(mobile.serial)) return false;
    if (!mobile.position || !here) return false;
    const away = distance(here, mobile.position);
    const swing = session.world.swings.get(mobile.serial);
    if (swing?.target === me && Date.now() - swing.at < 3000 && away <= 12) return true;
    if (attackingAt(session.world.animations.get(mobile.serial), mobile.position, here, away)) return true;
    if (!((mobile.flags ?? 0) & WAR_MODE) || !hostileNotoriety.includes(mobile.notoriety ?? 0) || harmless(mobile))
      return false;
    const stats = statsOf(mobile);
    const reach = stats && (castsSpells(stats) || RANGED_AI.has(stats.ai ?? '')) ? 10 : 2;
    return away <= reach;
  });
  const status = session.world.status;
  return { hits: status?.hits ?? 0, maxHits: status?.maxHits ?? 0, dead: ghost, held, spare, attackers };
}

export const statsOf = (mobile: Entity): Monster | undefined =>
  monsters.find(
    (m) =>
      m.bodies.includes(mobile.graphic) && (!mobile.name || (m.name ?? '').toLowerCase() === mobile.name.toLowerCase())
  ) ?? monsters.find((m) => m.bodies.includes(mobile.graphic));

// A creature that never starts a fight (ServUO: not aggressive, an animal's AI or no fight mode):
// no prey for a fighter, whatever it is worth.
export const harmless = (mobile: Entity) => {
  const stats = statsOf(mobile);
  return !!stats && !stats.aggressive && (stats.ai === 'Animal' || stats.fightMode === 'None');
};

// The share of its health a fight with `mobile` costs, fighting with `weapon` (or fists): ServUO's
// hit chance ((skill + 20) over twice the defender's + 20), about 8 + Tactics/10 a swing with a
// weapon, 2 + Tactics/40 bare-handed. A creature it has no record of counts as a hard fight.
export function fightShare(session: PlayerSession, mobile: Entity, weapon: Entity | undefined, maxHits: number) {
  return forecastFight(session, mobile, {
    weapon,
    status: { hits: session.world.status?.hits ?? maxHits, maxHits, armor: session.world.status?.armor }
  }).predictedLoss;
}

// ServUO creatures notice a fight within their perception range: 10 tiles for nearly every
// monster (the BaseCreature constructor's rangePerception).
const PERCEPTION = 10;

// How the resident weighs a fight: allies sharing it, wariness learned at this spot, its nerve,
// and the creatures it sees (by default, what its perception shows: danger.ts).
export interface Judgement {
  party?: number;
  caution?: number;
  riskTolerance?: number;
  casting?: boolean;
  seen?: Entity[];
}

// Everyone a fight with `target` brings: what attacks it already, the target, and every hostile
// creature in sight close enough to the target to notice.
export function fightGroup(session: PlayerSession, self: SelfState, target?: Entity, seen?: Entity[]): Entity[] {
  const group = new Map(self.attackers.map((mobile) => [mobile.serial, mobile]));
  if (target) group.set(target.serial, target);
  const at = target?.position;
  if (at)
    for (const mobile of seen ?? threatsNear(session, at, PERCEPTION))
      if (
        mobile.position &&
        distance(mobile.position, at) <= PERCEPTION &&
        hostileNotoriety.includes(mobile.notoriety ?? 0) &&
        !session.world.deaths.has(mobile.serial) &&
        !harmless(mobile)
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
  const { seen, ...weighing } = judgement;
  let remaining = fightGroup(session, self, target, seen);
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

// The fight as the logs show it: the forecast against `target` with everything it brings.
export function retaliationAssessment(session: PlayerSession, self: SelfState, target: Entity) {
  const forecast = forecastFight(session, target, {
    status: { hits: self.hits, maxHits: self.maxHits, armor: session.world.status?.armor },
    weapon: self.held ?? self.spare,
    opponents: fightGroup(session, self, target).map((mobile) => ({ mobile, weight: 1 }))
  });
  return {
    ...forecast,
    ok: canBeat(session, self, target),
    target: target.serial,
    name: target.name ?? statsOf(target)?.name ?? 'unknown',
    hits: self.hits,
    maxHits: self.maxHits,
    attackers: self.attackers.map((mobile) => mobile.serial)
  };
}
