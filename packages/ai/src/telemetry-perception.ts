import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { executionFor } from './execution-session';
import { lifeEvent } from './life-events';
import { perceptionFor } from './perception-session';
import { markThreat } from './telemetry-metrics';

const project = (entity: Readonly<Entity>) => ({
  serial: entity.serial,
  kind: entity.kind,
  graphic: entity.graphic,
  name: entity.name,
  parent: entity.parent,
  layer: entity.layer,
  amount: entity.amount,
  hue: entity.hue,
  position: entity.position,
  hits: entity.hits,
  maxHits: entity.maxHits,
  notoriety: entity.notoriety
});
export function observePerception(session: PlayerSession) {
  const model = perceptionFor(session);
  let entered = false;
  const previous = new Map<string, string>();
  const stop = session.world.observations.subscribe(
    (change) => {
      const self = model.self();
      markThreat(session, self.underAttack || self.damagedRecently, change.at);
      const selfDelta: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(self)) {
        const encoded = JSON.stringify(value);
        if (previous.get(key) !== encoded) {
          selfDelta[key] = value;
          previous.set(key, encoded);
        }
      }
      const initial = !entered && session.world.ready;
      if (initial) entered = true;
      const serials = initial
        ? [...session.world.entities.keys()]
        : [...new Set([...change.entities, ...change.contexts])];
      const entities = serials.slice(0, 512).flatMap((serial) => {
        const entity = session.world.entities.get(serial);
        if (!entity) return [];
        const perceived = entity.kind === 'mobile' ? model.entity(serial) : undefined;
        return [
          {
            ...project(entity),
            capabilities: perceived?.capabilities,
            role: perceived?.role,
            intent: perceived?.intent,
            risk: perceived?.risk
          }
        ];
      });
      if (
        !initial &&
        !Object.keys(selfDelta).length &&
        !entities.length &&
        !change.removed.length &&
        !change.skills.length &&
        !change.events.length
      )
        return;
      lifeEvent(session, initial ? 'perception_snapshot' : 'perception_delta', 'observed', {
        revision: change.revision,
        activeActions: executionFor(session)
          .arbiter.snapshot()
          .active.map(({ id, intentId, kind }) => ({ id, intentId, kind })),
        self: initial ? self : selfDelta,
        entities,
        removed: [...change.removed],
        skills: (initial ? [...session.world.skills.keys()] : change.skills).map((id) => ({
          id,
          ...session.world.skills.get(id)
        })),
        events: change.events,
        omittedEntities: Math.max(0, serials.length - 512),
        replayComplete: serials.length <= 512,
        source: 'decoded-server-observations',
        referenceSource: initial ? 'pinned ServUO catalogs; reference knowledge, not shard truth' : undefined
      });
    },
    (error) => lifeEvent(session, 'perception_telemetry', 'failed', { reason: String(error) })
  );
  session.signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
