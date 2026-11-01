import type { PlayerSession } from '@gemwright/network/session';

import { takingUrgentAction } from './action-purpose';
import { lifeEvent } from './life-events';
import { logger } from './log';
import { perceptionFor } from './perception-session';
import { pricedGoods } from './price-book';
import { workEvidence } from './work-evidence';

// An hourly account per resident of how it spent its time, the measure of whether it plays like a
// person: mostly its own work, few switches, attacks answered, few blocks, growing wealth and skill.
// One log line and one `behavior` journal event per hour, so 3 or 300 residents read the same way.
type Kind = 'core' | 'side' | 'combat' | 'idle';
const SIDE =
  /leisure|visit|life|errand|shop|buy|restock|bank|sell|social|talk|party|trade-|mount|pack-animal|house|guild/;
const COMBAT = /fight|skirmish|loot|combat|escap|retreat|avoid|scrap|hunt|opponent|ambush/;
const IDLE = /wait|reconcil|blocked|setback|loop|stuck|recover|death|ghost/;
const kindOf = (phase: string): Kind =>
  IDLE.test(phase) ? 'idle' : COMBAT.test(phase) ? 'combat' : SIDE.test(phase) ? 'side' : 'core';

interface Window {
  start: number;
  at: number;
  kind: Kind;
  ms: Record<Kind, number>;
  switches: number;
  blocks: number;
  unanswered: number;
  funds: number;
  skills: number;
}
const windows = new WeakMap<PlayerSession, Window>();

export function notePhase(session: PlayerSession, name: string, phase: string) {
  const now = Date.now();
  const evidence = workEvidence(session);
  const skills = Object.values(evidence.skills).reduce((sum, value) => sum + value, 0);
  let w = windows.get(session);
  if (!w) {
    w = {
      start: now,
      at: now,
      kind: 'core',
      ms: { core: 0, side: 0, combat: 0, idle: 0 },
      switches: 0,
      blocks: 0,
      unanswered: 0,
      funds: evidence.funds,
      skills
    };
    windows.set(session, w);
  }
  const kind = kindOf(phase);
  w.ms[w.kind] += now - w.at;
  if (kind !== w.kind) w.switches++;
  if (/blocked|loop|setback/.test(phase)) w.blocks++;
  // Hit or swung at while doing something other than fighting or getting away.
  if (perceptionFor(session).underAttack() && !takingUrgentAction(session) && kind !== 'combat') w.unanswered++;
  w.kind = kind;
  w.at = now;
  if (now - w.start < 60 * 60_000) return;
  const total = Math.max(1, now - w.start);
  const share = (k: Kind) => Math.round((w.ms[k] / total) * 100);
  const report = {
    core: share('core'),
    side: share('side'),
    combat: share('combat'),
    idle: share('idle'),
    switches: w.switches,
    blocks: w.blocks,
    unanswered: w.unanswered,
    funds: evidence.funds - w.funds,
    skills: Math.round((skills - w.skills) * 10) / 10,
    // What residents know of prices so far (price-book.ts): what trading can be worked out from.
    pricesCharged: pricedGoods('charges').length,
    pricesPaid: pricedGoods('pays').length
  };
  lifeEvent(session, 'behavior', 'observed', report);
  logger('behavior').info(
    `[${name}] hour: core ${report.core}% side ${report.side}% combat ${report.combat}% idle ${report.idle}%; switches ${report.switches}, blocks ${report.blocks}, unanswered attacks ${report.unanswered}; funds ${report.funds >= 0 ? '+' : ''}${report.funds}, skills +${report.skills}; known prices ${report.pricesCharged} charged, ${report.pricesPaid} paid`
  );
  windows.delete(session);
}
