import type { PlanEstimate } from './intent';
import type { PlanOutcome } from './plan-memory';
import type { GoalKind } from './resident-goal';
import type { Checkpoint } from './store';

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export function calibration(checkpoint: Checkpoint, now = Date.now()) {
  const events = (checkpoint.workGoal?.outcomes ?? []).filter(
    (event) => event.at <= now && now - event.at < 7 * 86400_000
  );
  let skillValue = 0,
    skillWeight = 0,
    lossRatio = 0,
    lossWeight = 0,
    earningRate = 1,
    rateWeight = 1;
  for (const event of events) {
    const weight = 1 - (Math.floor((now - event.at) / 60_000) * 60_000) / (7 * 86400_000);
    if (event.kind === 'earn' && event.wealth !== null && event.wealth > 0 && (event.durationMs ?? 0) >= 60_000) {
      earningRate += clamp(event.wealth / ((event.durationMs ?? 60_000) / 60_000), 0.1, 50) * weight;
      rateWeight += weight;
    }
    if (event.capability !== null && event.capability > 0 && event.result === 'completed') {
      const next = events.find(
        (later) =>
          later.at > event.at &&
          later.at - event.at <= 86400_000 &&
          later.kind === 'earn' &&
          later.wealth !== null &&
          later.wealth > 0
      );
      if (next?.wealth) {
        skillValue += clamp(next.wealth / event.capability, 0.5, 50) * weight;
        skillWeight += weight;
      }
    }
    if (event.loss !== undefined && event.loss !== null && event.prediction && event.loss > 0) {
      lossRatio += clamp(event.loss / Math.max(1, event.prediction.loss), 0.5, 3) * weight;
      lossWeight += weight;
    }
  }
  return {
    // Skill value is an observed association with later earnings, not a causal claim.
    alpha: (2 * 4 + skillValue) / (4 + skillWeight),
    beta: clamp((4 * (4 + lossRatio)) / (4 + lossWeight), 2, 12),
    opportunityRate: earningRate / rateWeight,
    samples: events.length,
    skillSamples: skillWeight,
    lossSamples: lossWeight,
    provenance: events.length ? ('outcome-calibrated-with-policy-priors' as const) : ('policy-priors' as const)
  };
}
export function calibrateEstimate(
  checkpoint: Checkpoint,
  kind: GoalKind,
  condition: string,
  prior: PlanEstimate,
  now = Date.now()
): PlanEstimate {
  const samples = (checkpoint.workGoal?.outcomes ?? []).filter(
    (event) =>
      event.kind === kind &&
      (!prior.method || !event.method || event.method === prior.method) &&
      event.condition === condition &&
      event.at <= now &&
      now - event.at < 86400_000
  );
  let total = 0,
    wealth = 0,
    capability = 0,
    deaths = 0,
    exposure = 0,
    minutes = 0,
    timeSamples = 0;
  for (const event of samples) {
    if (event.durationMs === undefined) continue;
    const recency = 1 - (Math.floor((now - event.at) / 60_000) * 60_000) / 86400_000;
    minutes += Math.min(60, event.durationMs / 60_000) * recency;
    timeSamples += recency;
    const weight = recency * Math.min(1, event.durationMs / (30 * 60_000));
    if (event.wealth !== null) {
      total += weight;
      wealth += event.wealth * weight;
    }
    if (event.capability !== null) capability += event.capability * weight;
    if (event.died === true) deaths += recency;
    else if (event.died === false) exposure += weight;
  }

  const riskSamples = deaths + exposure;
  // Observations govern the prior (twenty samples' weight): a death raises the estimate, and clean
  // runs relax it again. Never clamped above the prior, or one death would gate work forever.
  const deathRisk = prior.deathRisk === null ? null : (prior.deathRisk * 20 + deaths) / (20 + riskSamples);
  return {
    ...prior,
    source: total || riskSamples ? 'outcome-calibrated' : 'policy-estimate',
    wealth: (prior.wealth * 4 + wealth) / (4 + total),
    capability: (prior.capability * 4 + capability) / (4 + total),
    deathRisk,
    cost: (prior.cost * 4 + minutes * calibration(checkpoint, now).opportunityRate) / (4 + timeSamples),
    loss: prior.deathRisk && deathRisk !== null ? (prior.loss * deathRisk) / prior.deathRisk : prior.loss,
    calibration: {
      samples: samples.length,
      effectiveSamples: riskSamples,
      horizonMs: 30 * 60_000,
      deaths,
      censored: samples.filter((event) => event.died === undefined).length
    },
    uncertainty: Math.max(0.05, prior.uncertainty / Math.sqrt(1 + riskSamples / 20))
  };
}
export function outcomeLabels(
  state: { safe: boolean; evidence: { health: number } } | undefined,
  result: PlanOutcome['result']
) {
  return result === 'died' ? true : result === 'completed' && state?.safe ? false : undefined;
}
