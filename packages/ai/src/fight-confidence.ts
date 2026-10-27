import { skillId } from '@gemwright/common/skills';

import { monsters } from './dungeons';
import { bandage, type FighterContext, healPotion } from './fighter-context';
import { fightCost, recognised } from './fighter-prey';
import { alliesNear } from './hunting-party';
import { lasting } from './lasting';
import { distance } from './navigation';
import type { Entity } from './protocol/world';
import { selfNow } from './self';

// How sure a fighter is that it walks away from a fight, judged the way a player sizes one up: the
// target, and everything near it that would join in (archers and casters from farther off). Each creature costs a share of the fighter's
// health (fightCost: hit chances, damage, the time to kill it); casters add spell damage that armour
// does not stop, reduced by Magic Resist; party members split the cost. Against that stand current
// health and what it can heal with. A fighter's risk tolerance and a little chance decide where the
// line is, so two fighters in the same spot do not decide the same, and a recent death makes it warier.
const JOIN_RANGE = 8;
// By the creature's server brain (catalogs/monsters.json `ai`): spellcasters, and archers and
// casters that join from farther off than melee creatures.
const CASTERS = new Set(['Mage', 'NecroMage', 'Spellbinder', 'Spellweaving', 'Mystic', 'Necro']);
const RANGED = new Set([...CASTERS, 'Archer', 'OrcScout']);
const casts = (stats?: { ai?: string | null; magery: number }) =>
  !!stats && (CASTERS.has(stats.ai ?? '') || stats.magery >= 50);

// Deaths are kept across restarts (lasting.ts, stuck.ts noteDeath); this hook stays for callers.
export const rememberDeath = (_session: object) => {};

const statsOf = (mobile: Entity) =>
  monsters.find(
    (m) =>
      m.bodies.includes(mobile.graphic) && (!mobile.name || (m.name ?? '').toLowerCase() === mobile.name.toLowerCase())
  ) ?? monsters.find((m) => m.bodies.includes(mobile.graphic));

export function fightConfidence(ctx: FighterContext, target: Entity): { ok: boolean; reason: string } {
  const skill = (name: string) => ctx.session.world.skills.get(skillId(name))?.value ?? 0;
  const status = ctx.status();
  const at = target.position ?? ctx.position();
  const cost = (mobile: Entity) => {
    const stats = statsOf(mobile);
    if (!stats) return 0.5;
    const melee = Math.min(1.5, fightCost(ctx, stats.type));
    // Spells (Energy Bolt, Flame Strike, Explosion) land through armour: roughly a fifth of the
    // fighter's health per fight from a strong caster, less with Magic Resist.
    const spells = casts(stats)
      ? 0.2 * (Math.max(50, stats.magery) / 100) * Math.max(0.2, 1 - skill('MagicResist') / 120)
      : 0;
    return melee + spells;
  };
  const joining = ctx
    .nearby()
    .filter(
      (other) =>
        other.serial !== target.serial &&
        recognised(other.graphic) &&
        !ctx.session.world.deaths.has(other.serial) &&
        other.position &&
        distance(other.position, at) <= (RANGED.has(statsOf(other)?.ai ?? '') ? JOIN_RANGE + 4 : JOIN_RANGE)
    );
  const casters = [target, ...joining].filter((mobile) => casts(statsOf(mobile))).length;
  // A healer among them keeps the others standing: every fight there lasts longer.
  const healed = joining.some((mobile) => statsOf(mobile)?.ai === 'Healer') ? 1.3 : 1;
  const party = alliesNear(ctx, at).length + 1;
  const loss = ((cost(target) + joining.reduce((sum, other) => sum + 0.7 * cost(other), 0)) * healed) / party;
  const healing = Math.min(0.4, (ctx.count(bandage) >= 5 ? 0.25 : 0) + Math.min(2, ctx.count(healPotion)) * 0.1);
  const margin = status.hits / Math.max(1, status.maxHits) + healing - loss;
  // Dying is the worst outcome (it loses everything carried), so the line rises with each death
  // in the last hour (kept across restarts) and with what a death would cost now: carried gold
  // and loot. No new fight is started below 60% health at all.
  if (status.hits < status.maxHits * 0.6)
    return { ok: false, reason: `only ${Math.round((status.hits / Math.max(1, status.maxHits)) * 100)}% health` };
  const recentDeath = Math.min(0.3, lasting('deaths', ctx.serial).count() * 0.1);
  // What it knows of itself (self.ts): good gear and skill make it bolder; what it would lose
  // (gear worn, gold and goods carried, against all it owns) makes it careful. Both grow with it.
  const self = ctx.checkpoint ? selfNow(ctx.session, ctx.checkpoint, ctx.template) : undefined;
  const stakes = self
    ? Math.min(0.2, (self.atRisk / Math.max(1500, self.wealth)) * 0.2)
    : Math.min(0.15, ((status.gold ?? 0) + (ctx.trip?.loot.length ?? 0) * 50) / 10_000);
  const confidence = self ? (self.power - 0.5) * 0.3 : 0;
  const line =
    0.35 +
    (0.5 - ctx.template.behavior.riskTolerance) * 0.4 +
    recentDeath +
    stakes -
    confidence +
    (Math.random() - 0.5) * 0.15;
  const crowd = joining.length ? `, ${joining.length} more nearby${casters ? ` (${casters} casting)` : ''}` : '';
  const reason = `expects to lose ${Math.round(loss * 100)}% of its health${crowd}; margin ${margin.toFixed(2)} against ${line.toFixed(2)}`;
  return { ok: margin >= line, reason };
}
