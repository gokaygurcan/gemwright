import type { CharacterTemplate } from './config';

// Per-resident temperament: two residents of one template are different people. Values derive
// deterministically from the resident id, so a character keeps its temperament across restarts
// and template revisions, and nothing random is persisted.
export interface Temperament {
  // Added to the template's risk tolerance, clamped to 0..1.
  riskShift: number;
  // Added to the template's bank-at-weight ratio.
  bankRatioShift: number;
  // Carried gold that prompts a (soft) bank trip.
  carriedGold: number;
  // Health ratio below which the fighter bandages between fights.
  fieldHealAt: number;
  // First patrol landmark and direction around the graveyard.
  patrolOffset: number;
  patrolReverse: boolean;
  // Offset of the miner's favourite spot from the town's mining district centre.
  miningAnchor: { dx: number; dy: number };
  // Life phases last 1/restlessness as long as configured (life.ts); restless residents switch more.
  restlessness: number;
  // Above 1 a homebody, staying in its own town; below 1 it likes to travel (life.ts visits).
  homebody: number;
}

function unit(seed: string, salt: string): number {
  let hash = 2166136261;
  for (const character of `${salt}:${seed}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash / 2 ** 32;
}

export function temperamentOf(residentId: string): Temperament {
  const between = (salt: string, low: number, high: number) => low + unit(residentId, salt) * (high - low);
  return {
    riskShift: Number(between('risk', -0.15, 0.15).toFixed(3)),
    bankRatioShift: Number(between('bank', -0.08, 0.05).toFixed(3)),
    carriedGold: Math.round(between('gold', 800, 2500) / 50) * 50,
    fieldHealAt: Number(between('heal', 0.75, 0.95).toFixed(2)),
    patrolOffset: Math.floor(between('patrol', 0, 4)),
    patrolReverse: unit(residentId, 'reverse') < 0.5,
    miningAnchor: { dx: Math.round(between('mine-x', -60, 60)), dy: Math.round(between('mine-y', -60, 60)) },
    restlessness: Number(between('restless', 0.7, 1.3).toFixed(2)),
    homebody: Number(between('homebody', 0.5, 2).toFixed(2))
  };
}

// The template a resident actually acts on: the shared policy shaded by its own temperament.
export function personalTemplate(template: CharacterTemplate, residentId: string): CharacterTemplate {
  const temperament = temperamentOf(residentId);
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  return {
    ...template,
    behavior: {
      ...template.behavior,
      riskTolerance: clamp(template.behavior.riskTolerance + temperament.riskShift, 0, 1),
      bankAtWeightRatio: clamp(template.behavior.bankAtWeightRatio + temperament.bankRatioShift, 0.5, 0.95),
      temperament
    }
  };
}
