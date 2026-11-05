export interface DecisionCandidate {
  id: string;
  description: string;
  valid: () => boolean;
}

export function localDecision(offered: DecisionCandidate[], preferred: string) {
  const candidates = offered.filter((candidate) => candidate.valid());
  if (
    !candidates.length ||
    candidates.length > 8 ||
    new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length ||
    candidates.some((candidate) => !/^[a-z][a-z0-9-]{0,63}$/.test(candidate.id))
  )
    throw new Error('Invalid decision candidates');
  const baseline = candidates.find((candidate) => candidate.id === preferred) ?? candidates[0];
  if (!baseline) throw new Error('Decision baseline unavailable');
  return { candidates, baseline };
}
