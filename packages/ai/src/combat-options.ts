// Finish, step back to heal, or get away, by the resident's own risk tolerance: it fights on while
// finishing costs less than that share of the health it has now, and steps back to heal first when
// finishing would leave it below the share of its full health it will not risk, a heal fixes that,
// and the kill costs more than the pause. Otherwise it leaves.
export function compareCombatOptions(input: {
  hits: number;
  maxHits: number;
  incomingPerSecond: number;
  secondsToDefeat: number;
  healAmount?: number;
  healSeconds?: number;
  potionAmount?: number;
  escapeSeconds?: number;
  escapeExposure?: number;
  riskTolerance?: number;
}) {
  const health = Math.max(0, input.hits + (input.potionAmount ?? 0));
  const pressure = Math.max(0, input.incomingPerSecond);
  const exposure = input.escapeExposure ?? 0.25;
  const escapeSeconds = input.escapeSeconds ?? 3;
  const healSeconds = input.healSeconds ?? 8;
  const tolerance = input.riskTolerance ?? 0.5;
  const reserve = input.maxHits * (1 - tolerance);
  const fightLoss = pressure * input.secondsToDefeat;
  const escapeLoss = pressure * escapeSeconds * exposure;
  const withdrawalLoss = pressure * Math.max(escapeSeconds, healSeconds) * exposure;
  const restored = Math.min(input.maxHits, health - withdrawalLoss + (input.healAmount ?? 0));
  const healing = (input.healAmount ?? 0) > withdrawalLoss;
  const finish = fightLoss < health * tolerance;
  const heal =
    healing && health - fightLoss < reserve && fightLoss > withdrawalLoss && fightLoss < restored * tolerance;
  const action = heal ? ('bandage-break' as const) : finish ? ('press-attack' as const) : ('flee-town' as const);
  return {
    action,
    attack: fightLoss,
    recover: healing ? withdrawalLoss + fightLoss : Infinity,
    escape: escapeLoss,
    fightLoss,
    withdrawalLoss,
    secondsToDefeat: input.secondsToDefeat
  };
}
