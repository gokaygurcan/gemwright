export interface HealthChange {
  at: number;
  hits: number;
  maxHits: number;
  damage: number;
  healed: number;
}
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
  const lethalRepeat = largestHit >= maxHits * 0.35 && largestHit * 1.15 >= hits;
  const lethalBurst = damageLast3s >= maxHits * 0.5 && damageLast3s >= hits;
  const emergency =
    healthRatio <= 0.2 || lethalRepeat || lethalBurst || (secondsToExhaustion !== null && secondsToExhaustion < 3);
  const canBandage = options.bandages > 0 || bandageSecondsRemaining > 0;
  const cannotOutlastHeal =
    secondsToExhaustion !== null && secondsToExhaustion < Math.max(4, Math.min(8, bandageSecondsRemaining || 8));
  const finishLikely =
    options.opponentHealthRatio !== undefined &&
    options.opponentHealthRatio < 0.15 &&
    healthRatio > 0.55 &&
    !cannotOutlastHeal;
  const healingHorizon = Math.max(4, Math.min(8, bandageSecondsRemaining || 8));
  const projectedHealthRatioAtHeal = Math.max(0, hits - damagePerSecond * healingHorizon) / Math.max(1, maxHits);
  const deteriorating = damagePerSecond > 0 && projectedHealthRatioAtHeal < 0.5 - options.riskTolerance * 0.1;
  const needsBreak = (healthRatio < 0.78 - options.riskTolerance * 0.12 || deteriorating) && !finishLikely;
  let baseline: CombatAssessment['baseline'] = 'press-attack';
  let reason = 'Observed damage is manageable; keep fighting with local healing.';
  if (emergency) {
    baseline = 'flee-town';
    reason = lethalRepeat
      ? 'One more hit comparable to the recent burst could kill this character.'
      : lethalBurst
        ? 'Recent burst damage could exhaust remaining health before recovery.'
        : 'Remaining health or observed damage rate requires immediate escape.';
  } else if (needsBreak) {
    if (!canBandage && options.potionReady && !cannotOutlastHeal) {
      baseline = 'press-attack';
      reason =
        'An immediate healing potion is available while the observed incoming damage remains survivable; verify its actual effect.';
    } else if (!canBandage || (cannotOutlastHeal && !options.canCreateDistance)) {
      baseline = 'flee-town';
      reason = 'The observed damage rate or missing bandages leaves no credible healing window.';
    } else {
      baseline = 'bandage-break';
      reason = 'Create distance, self-bandage while avoiding further hits, then reassess before re-engaging.';
    }
  }
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
