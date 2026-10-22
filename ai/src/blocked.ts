export type BlockedReason = 'unreachable' | 'locked-door' | 'no-vendor' | 'insufficient-funds' | 'missing-tool';

// A legal, explainable impossibility reported by server feedback or observations.
// Behaviors either route around it or stop with this reason instead of retrying blindly.
export class Blocked extends Error {
  constructor(
    readonly reason: BlockedReason,
    message: string
  ) {
    super(message);
    this.name = 'Blocked';
  }
}

export const blockedReason = (error: unknown) => (error instanceof Blocked ? error.reason : undefined);
