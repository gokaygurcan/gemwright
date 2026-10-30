import { hostileNotoriety } from '@gemwright/network/opcodes';
import { Actions } from '@gemwright/network/replies';
import type { WorldView } from '@gemwright/network/world';
import type { Entity } from '@gemwright/network/world-types';

import { baselineTraits } from './perception-reference';
import { type Inference, type Known, observed, type PerceivedEntity, unknown } from './perception-types';

export interface EntityObservation {
  entity: Readonly<Entity>;
  at: number;
  facet: Known<number>;
  removedAt?: number;
}
const itemReference = {
  kind: 'reference' as const,
  source: 'creature reference does not apply to items',
  value: { humanLike: false, candidates: [], aggressive: null }
};
const commands = new Map<number, 'buy' | 'sell' | 'bank'>([
  [Actions.buy, 'buy'],
  [Actions.sell, 'sell'],
  [Actions.bank, 'bank']
]);

export function perceiveEntity(
  world: WorldView,
  record: EntityObservation,
  visible: boolean,
  now: number,
  swing?: { target: number; at: number },
  owned = false
): PerceivedEntity {
  const entity = record.entity;
  const reference = entity.kind === 'mobile' ? baselineTraits(entity.graphic, entity.name) : itemReference;
  const menu = world.contextMenus.get(entity.serial);
  const contextAt = world.observations.contextAt.get(entity.serial);
  const capabilities =
    menu && contextAt !== undefined
      ? now - contextAt > 15 * 60_000
        ? unknown('stale', contextAt)
        : observed(
            menu.flatMap((e) => {
              const command = !(e.flags & 1) && commands.get(e.cliloc);
              return command ? [command] : [];
            }),
            contextAt
          )
      : unknown('not-observed');
  const health =
    entity.hits !== undefined && entity.maxHits !== undefined && entity.healthAt !== undefined
      ? now - entity.healthAt > 5000
        ? unknown('stale', entity.healthAt)
        : observed({ current: entity.hits, max: entity.maxHits }, entity.healthAt)
      : unknown('not-observed');
  const vendor = capabilities.kind === 'observed' && capabilities.value.length > 0;
  const role = vendor
    ? {
        kind: 'inferred' as const,
        value: 'vendor' as const,
        at: now,
        confidence: 0.95,
        evidence: ['enabled server context-menu capabilities']
      }
    : entity.name &&
        reference.value.candidates.some((candidate) => candidate.name?.toLowerCase() === entity.name?.toLowerCase())
      ? {
          kind: 'inferred' as const,
          value: 'creature' as const,
          at: now,
          confidence: entity.name ? 0.7 : 0.4,
          evidence: ['baseline appearance candidates; shard type unconfirmed']
        }
      : unknown('ambiguous');
  const recent = visible && swing && now >= swing.at && now - swing.at < 3000;
  const intent = recent
    ? observed(swing.target === world.serial ? ('attacking-self' as const) : ('attacking-other' as const), swing.at)
    : unknown('not-observed');
  let risk: Inference<'immediate' | 'caution' | 'unknown'> = {
    kind: 'inferred',
    value: 'unknown',
    at: now,
    confidence: 0,
    evidence: ['no evidence of hostile intent']
  };
  if (!visible) risk = { ...risk, evidence: ['current presence unconfirmed'] };
  else if (intent.kind === 'observed' && intent.value === 'attacking-self')
    risk = { kind: 'inferred', value: 'immediate', at: now, confidence: 1, evidence: ['observed swing targets self'] };
  else if (!vendor && [4, 5, 6].includes(entity.notoriety ?? 0))
    risk = {
      kind: 'inferred',
      value: 'caution',
      at: now,
      confidence: 0.5,
      evidence: ['notoriety raises risk; does not establish intent']
    };
  else if (!vendor && reference.value.aggressive === true && hostileNotoriety.includes(entity.notoriety ?? 0))
    risk = {
      kind: 'inferred',
      value: 'caution',
      at: now,
      confidence: 0.7,
      evidence: ['baseline aggression prior and observed notoriety; shard behavior unconfirmed']
    };
  return {
    serial: entity.serial,
    facts: observed(entity, record.at),
    facet: record.facet,
    visible,
    presence: record.removedAt !== undefined ? 'removed' : visible ? 'visible' : owned ? 'carried' : 'unseen',
    reference,
    health,
    capabilities,
    role,
    intent,
    risk
  };
}
