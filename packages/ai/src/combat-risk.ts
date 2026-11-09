import type { HealthChange } from '@gemwright/network/world-types';

import { compareCombatOptions } from './combat-options';

export type { HealthChange } from '@gemwright/network/world-types';

export interface CombatAssessment {
  healthRatio: number;
  largestHit: number;
  lastHit: number;
  damageLast3s: number;
  damageLast8s: number;
  damagePerSecond: number;
  healingLast8s: number;
  secondsToExhaustion: number | null;
  bandageSecondsRemaining: number;
  potionReady: boolean;
  projectedHealthRatioAtHeal: number;
  emergency: boolean;
  reason: string;
  baseline: 'press-attack' | 'bandage-break' | 'flee-town';
}

export function assessCombat(options: {
  now: number;
  hits: number;
  maxHits: number;
  changes: readonly HealthChange[];
  bandages: number;
  bandageActiveUntil: number;
  potionReady: boolean;
  riskTolerance: number;
  opponentHealthRatio?: number;
  canCreateDistance?: boolean;
  secondsToDefeat?: number;
  incomingPerSecond?: number;
  healAmount?: number;
  potionAmount?: number;
}): CombatAssessment {
  const { now, hits, maxHits } = options;
  const recent = options.changes.filter((change) => now - change.at >= 0 && now - change.at <= 8000);
  const damage = recent.filter((change) => change.damage > 0);
  const largestHit = Math.max(0, ...damage.map((change) => change.damage));
  const lastHit = damage.at(-1)?.damage ?? 0;
  const damageLast3s = damage
    .filter((change) => now - change.at <= 3000)
    .reduce((sum, change) => sum + change.damage, 0);
  const damageLast8s = damage.reduce((sum, change) => sum + change.damage, 0);
  const span = damage.length ? Math.max(2.5, Math.min(8, (now - (damage[0]?.at ?? now)) / 1000 + 2.5)) : 8;
  const damagePerSecond = Math.max(damageLast3s / 3, damageLast8s / span);
  const secondsToExhaustion = damagePerSecond > 0 ? hits / damagePerSecond : null;
  const healthRatio = maxHits > 0 ? hits / maxHits : 0;
  const bandageSecondsRemaining = Math.max(0, (options.bandageActiveUntil - now) / 1000);
  const pressure = options.incomingPerSecond ?? damagePerSecond;
  const comparison = compareCombatOptions({
    hits,
    maxHits,
    incomingPerSecond: pressure,
    secondsToDefeat: options.secondsToDefeat ?? 2 + 8 * (options.opponentHealthRatio ?? 1),
    healAmount: options.bandages > 0 || bandageSecondsRemaining > 0 ? (options.healAmount ?? 30) : 0,
    healSeconds: bandageSecondsRemaining || 8,
    potionAmount: options.potionReady ? (options.potionAmount ?? Math.min(maxHits - hits, 20)) : 0,
    escapeExposure: options.canCreateDistance ? 0.25 : 1,
    riskTolerance: options.riskTolerance
  });
  const projectedHealthRatioAtHeal = Math.max(0, hits - comparison.withdrawalLoss) / Math.max(1, maxHits);
  const baseline = comparison.action;
  const emergency = baseline === 'flee-town';
  const reason = `Expected cost: finish ${comparison.attack.toFixed(2)}, recover ${comparison.recover.toFixed(2)}, escape ${comparison.escape.toFixed(2)}; finishing in ${comparison.secondsToDefeat.toFixed(2)}s at ${pressure.toFixed(2)} incoming HP/s`;

  return {
    healthRatio,
    largestHit,
    lastHit,
    damageLast3s,
    damageLast8s,
    damagePerSecond,
    healingLast8s: recent.reduce((sum, change) => sum + change.healed, 0),
    secondsToExhaustion,
    bandageSecondsRemaining,
    potionReady: options.potionReady,
    projectedHealthRatioAtHeal,
    emergency,
    reason,
    baseline
  };
}
