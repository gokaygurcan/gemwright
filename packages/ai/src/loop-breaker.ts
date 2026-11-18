// Failed execution and completed-but-unproductive work have separate, bounded budgets.
export class LoopBreaker {
  private readonly attempts = new Map<string, { failures: number; empty: number; until: number; at: number }>();
  private turns = 0;
  private since: number;
  // How long it may go without progress: at least two minutes, longer while a long plan is under way.
  private window = 120_000;

  constructor(now = Date.now()) {
    this.since = now;
  }

  allows(key: string, now = Date.now()) {
    const past = this.attempts.get(key);
    if (!past) return true;
    if (past.until && past.until <= now) {
      this.attempts.delete(key);
      return true;
    }
    return !past.until;
  }

  finish(key: string, completed: boolean, productive: boolean, now = Date.now()) {
    if (productive) {
      this.attempts.delete(key);
      this.turns = 0;
      this.since = now;
      this.window = 120_000;
      return;
    }
    for (const [id, entry] of this.attempts) {
      if (now - entry.at >= 300_000) this.attempts.delete(id);
    }
    this.turns++;
    const past = this.attempts.get(key) ?? { failures: 0, empty: 0, until: 0, at: now };
    past.at = now;
    past.empty++;
    if (!completed) past.failures++;
    if (past.failures >= 3 || past.empty >= 6) past.until = now + 300_000;
    this.attempts.set(key, past);
  }

  stalled(now = Date.now()) {
    return this.turns >= 12 || now - this.since >= this.window;
  }

  // A plan expected to take `ms` is under way: no progress until it ends is not a stall.
  started(ms: number, now = Date.now()) {
    this.window = Math.max(120_000, now - this.since + ms);
  }

  relocated(now = Date.now()) {
    this.turns = 0;
    this.since = now;
    this.window = 120_000;
  }
}

// How long a plan may run before it is given up: as long as it is expected to take (the walk there
// included), stretched by the resident's patience; never under a minute.
export const planBudget = (seconds: number, patience: number) => Math.max(60_000, seconds * 1000 * (1 + patience));
