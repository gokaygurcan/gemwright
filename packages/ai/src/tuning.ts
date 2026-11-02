import { readFileSync } from 'node:fs';

// How far a resident walks to a place before taking the gate instead. One value, one place.
export const WALKING_LIMIT = 300;

// Gameplay thresholds in one file (packages/ai/tuning.json), so tuning from what the pulls show
// needs no code change. Read once at start; a deploy carries a new copy.
interface Tuning {
  escort: { seekBelowGold: number; walkToGate: number };
  fighter: { supplyRunMinGold: number; ammoLow: number; reagentLow: number; carriedGold: number };
  sideTrade: { checkHours: number; spellHours: number; lessonTo: number; lessonMinGold: number };
  trouble: { holdHours: number; penaltyAt: number; stepCost: number; deadlyAt: number; deadlyStepCost: number };
  taming: { emptySearches: number; givenUpHours: number };
}
export const tuning = JSON.parse(readFileSync(new URL('../tuning.json', import.meta.url), 'utf8')) as Tuning;
