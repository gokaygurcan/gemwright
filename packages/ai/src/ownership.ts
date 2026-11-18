import { logger } from './log';
import type { ResidentStore } from './store';

// The single-writer shard lease. A lease renewal goes through the same durable write queue as the
// residents' checkpoints, so it can be delayed by a busy writer or a burst of saves: the lease lasts
// two minutes and is renewed every thirty seconds, a missed beat is retried, and ownership is only
// declared lost when the lease has actually run out (plus a short grace) — a transient write hiccup
// must never close every session in the town.
const LEASE_MS = 120_000;
const BEAT_MS = 30_000;
const GRACE_MS = 10_000;

export class RuntimeOwnership {
  private readonly token: string;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private expiresAt = Date.now() + LEASE_MS;
  private lost = false;
  private renewing = false;

  constructor(
    private readonly store: ResidentStore,
    onLost: () => void
  ) {
    this.token = store.acquireLease(LEASE_MS);
    this.heartbeat = setInterval(() => this.renew(onLost), BEAT_MS);
  }

  private renew(onLost: () => void) {
    if (this.renewing || this.lost) return;
    this.renewing = true;
    try {
      this.store.renewLease(this.token, LEASE_MS);
      this.expiresAt = Date.now() + LEASE_MS;
    } catch (error) {
      // Retried on the next beat: only an actually expired lease means another runtime may take over.
      logger('runtime').error(
        `[persistence] Lease renewal failed (${error instanceof Error ? error.message : String(error)}); retrying`
      );
      if (Date.now() > this.expiresAt + GRACE_MS) {
        this.lost = true;
        clearInterval(this.heartbeat);
        onLost();
      }
    } finally {
      this.renewing = false;
    }
  }

  assert(): void {
    if (this.lost || Date.now() >= this.expiresAt) throw new Error('Runtime no longer owns this shard');
  }

  close(): void {
    this.lost = true;
    clearInterval(this.heartbeat);
    try {
      this.store.releaseLease(this.token);
    } catch (error) {
      logger('runtime').error(
        `[persistence] Could not release the runtime lease: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
