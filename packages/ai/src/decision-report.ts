import { type DecisionMemory, type DecisionTally, underperforms } from './decisions';

export function decisionReport(memory: DecisionMemory | undefined) {
  return Object.entries(memory?.tally ?? {}).map(([kind, tally]) => {
    const rate = (outcomes: DecisionTally['outcomes']) => {
      const total = (outcomes.completed ?? 0) + (outcomes.failed ?? 0);
      return total ? Number(((outcomes.completed ?? 0) / total).toFixed(3)) : null;
    };
    const agreeing = Object.fromEntries(
      (['completed', 'failed', 'interrupted'] as const).map((status) => [
        status,
        (tally.outcomes[status] ?? 0) - (tally.divergentOutcomes[status] ?? 0)
      ])
    );
    return {
      kind,
      decisions: tally.decisions,
      divergent: tally.divergent,
      baselineSuccessRate: rate(agreeing),
      divergentSuccessRate: rate(tally.divergentOutcomes),
      providerConsulted: !underperforms(tally)
    };
  });
}
// Sums several residents' tallies into one memory for a fleet report, and counts who decided the
// retained traces per kind: the model, or the local rule with the reason Jev was not asked.
export function mergeDecisionMemory(memories: (DecisionMemory | undefined)[]) {
  const tally: Record<string, DecisionTally> = {};
  const sources: Record<string, Record<string, number>> = {};
  const add = (into: Partial<Record<string, number>>, from: Partial<Record<string, number>>) => {
    for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + (value ?? 0);
  };
  for (const memory of memories) {
    for (const [kind, own] of Object.entries(memory?.tally ?? {})) {
      const sum = tally[kind] ?? { decisions: 0, divergent: 0, outcomes: {}, divergentOutcomes: {} };
      tally[kind] = sum;
      sum.decisions += own.decisions;
      sum.divergent += own.divergent;
      add(sum.outcomes, own.outcomes);
      add(sum.divergentOutcomes, own.divergentOutcomes);
    }
    for (const trace of memory?.history ?? []) {
      const counts = sources[trace.kind] ?? {};
      sources[trace.kind] = counts;
      const key = trace.source === 'model' ? 'model' : `${trace.source}:${trace.reason}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  const memory: DecisionMemory = {
    schemaVersion: 1,
    budget: { day: '', attempts: 0, chargedInputTokens: 0 },
    history: [],
    tally
  };
  return { memory, sources };
}
