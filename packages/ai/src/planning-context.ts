import { createHash } from 'node:crypto';

import { Layer } from '@gemwright/network/layers';

import type { PlanningContext } from './intent';
import { serviceLocations, townAt } from './locations';
import { distance } from './navigation';
import { perceptionFor } from './perception-session';
import type { ProfessionContext } from './profession';
import { selfNow } from './self';
import type { WorkEvidence } from './work-evidence';

export function planningContext(ctx: ProfessionContext, evidence: WorkEvidence): PlanningContext {
  const model = perceptionFor(ctx.session);
  const self = model.self();
  const visible = model.visibleEntities('mobile');
  const caution = visible.filter((entity) => entity.risk.value === 'caution').length;
  const immediate =
    visible.some((entity) => entity.risk.value === 'immediate') || self.underAttack || self.damagedRecently;
  const uncertainty = Math.min(1, 0.2 + caution * 0.2 + (self.poison.kind === 'unknown' ? 0.3 : 0));
  const bank = [...serviceLocations(townAt(ctx.position(), ctx.city), 'banker')].sort(
    (a, b) => distance(ctx.position(), a) - distance(ctx.position(), b)
  )[0];
  const escapeKnown = !!bank && distance(ctx.position(), bank) <= 18 && caution === 0 && !immediate;
  const _equipment = ctx.session.world
    .childrenOf(ctx.serial)
    .filter((item) => item.layer !== Layer.Backpack && item.layer !== Layer.Bank)
    .map((item) => [item.layer, item.graphic, item.hue ?? 0])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  // What a remembered failure is filed under. It must be stable across an errand: carried graphics,
  // exact equipment and the tile the resident stood on change constantly, and hashing them made a
  // learned obstacle vanish the moment the resident shopped or picked something up. Where it is,
  // what it was doing and with what means (funds band, skill bands) are the durable parts.
  const area = townAt(ctx.position(), ctx.city);
  const coarse = createHash('sha256')
    .update(JSON.stringify([ctx.session.world.map, area, ctx.template.archetype?.id]))
    .digest('hex');
  const condition = createHash('sha256')
    .update(
      JSON.stringify([
        ctx.session.world.map,
        area,
        ctx.template.archetype?.id,
        evidence.bankKnown,
        Math.floor(Math.log2(evidence.funds + 1)),
        Object.entries(evidence.skills)
          .sort()
          .map(([id, value]) => [id, Math.floor(value / 10)])
      ])
    )
    .digest('hex');
  const held = selfNow(ctx.session, ctx.checkpoint, ctx.template);
  return {
    condition,
    coarse,
    evidence: [
      {
        id: 'perception:health',
        kind: self.health.kind,
        source: 'Server health observation',
        value: self.health.kind === 'observed' ? self.health.value : self.health.reason,
        at: self.health.kind === 'observed' ? self.health.at : undefined
      },
      {
        id: 'perception:position',
        kind: self.position.kind,
        source: 'Server position observation',
        value: self.position.kind === 'observed' ? self.position.value : self.position.reason,
        at: self.position.kind === 'observed' ? self.position.at : undefined
      },
      {
        id: 'perception:threats',
        kind: 'inferred',
        source: 'Visible entity observations and aggression signals',
        value: { caution, immediate, range: model.viewRange() }
      },
      {
        id: 'reference:refuge',
        kind: 'reference',
        source: 'Shard bank landmark catalog; reachability must be verified during travel',
        value: bank ?? null
      }
    ],
    available: model.available && self.health.kind === 'observed' && self.position.kind === 'observed',
    riskTolerance: ctx.template.behavior.riskTolerance,
    exposed: held.atRisk,
    // Worn gear and the working kit (tools, bandages, reagents) cannot be banked away, so only
    // carried gold and sellable goods may shrink the risk budget.
    securable: held.carried.gold + held.carried.securable,
    escapeKnown,
    uncertainty,
    // Prior over the thirty-minute planning horizon; goal-policy calibrates it from outcomes. The
    // scales are sanity bounds, not promises: ordinary guarded work must pass at default tolerance,
    // while sustained threat, harm and unknowns gate it. Travel and combat retain their own
    // eligibility checks at execution time.
    deathRisk:
      self.health.kind !== 'observed'
        ? null
        : immediate
          ? 1
          : Math.min(
              1,
              0.001 +
                caution * 0.004 +
                (1 - self.health.value.current / Math.max(1, self.health.value.max)) * 0.05 +
                uncertainty * 0.004
            )
  };
}
