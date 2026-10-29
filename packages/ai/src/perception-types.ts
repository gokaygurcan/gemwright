import type { Entity, Position } from '@gemwright/network/world-types';

export interface Unknown {
  kind: 'unknown';
  reason: 'not-observed' | 'stale' | 'out-of-view' | 'removed' | 'disconnected' | 'ambiguous' | 'perception-failed';
  lastObservedAt?: number;
}
export interface Observation<T> {
  kind: 'observed';
  value: T;
  at: number;
}
export interface Reference<T> {
  kind: 'reference';
  value: T;
  source: string;
}
export interface Inference<T> {
  kind: 'inferred';
  value: T;
  at: number;
  confidence: number;
  evidence: readonly string[];
}
export type Known<T> = Observation<T> | Unknown;
export const unknown = (reason: Unknown['reason'], lastObservedAt?: number): Unknown => ({
  kind: 'unknown',
  reason,
  ...(lastObservedAt === undefined ? {} : { lastObservedAt })
});
export const observed = <T>(value: T, at: number): Observation<T> => ({ kind: 'observed', value, at });

export interface CreaturePrior {
  type: string;
  name: string | null;
  aggressive: boolean | null;
  hits: readonly number[] | null;
  damage: readonly number[] | null;
}
export interface BaselineTraits {
  humanLike: boolean;
  candidates: readonly CreaturePrior[];
  aggressive: boolean | null;
}
export interface PerceivedEntity {
  serial: number;
  facts: Observation<Readonly<Entity>>;
  facet: Known<number>;
  visible: boolean;
  presence: 'visible' | 'unseen' | 'carried' | 'removed';
  reference: Reference<BaselineTraits>;
  health: Known<{ current: number; max: number }>;
  capabilities: Known<readonly ('buy' | 'sell' | 'bank')[]>;
  role: Inference<'vendor' | 'creature'> | Unknown;
  intent: Known<'attacking-self' | 'attacking-other'>;
  risk: Inference<'immediate' | 'caution' | 'unknown'>;
}
export interface SelfPerception {
  available: boolean;
  life: Known<'alive' | 'dead'>;
  position: Known<Readonly<Position>>;
  facet: Known<number>;
  health: Known<{ current: number; max: number }>;
  mana: Known<{ current: number; max: number }>;
  stamina: Known<{ current: number; max: number }>;
  weight: Known<{ current: number; max: number }>;
  reportedGold: Known<number>;
  poison: Known<number>;
  damagedRecently: boolean;
  underAttack: boolean;
}
