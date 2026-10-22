import type { ResidentStore } from './store';

export class RuntimeOwnership {
  private readonly token: string;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private expiresAt = Date.now() + 30000;
  private lost = false;

  constructor(
    private readonly store: ResidentStore,
    onLost: () => void
  ) {
    this.token = store.acquireLease();
    this.heartbeat = setInterval(() => {
      try {
        store.renewLease(this.token);
        this.expiresAt = Date.now() + 30000;
      } catch {
        this.lost = true;
        clearInterval(this.heartbeat);
        onLost();
      }
    }, 10000);
  }

  assert(): void {
    if (this.lost || Date.now() >= this.expiresAt) throw new Error('Runtime no longer owns this shard');
  }

  close(): void {
    this.lost = true;
    clearInterval(this.heartbeat);
    this.store.releaseLease(this.token);
  }
}
