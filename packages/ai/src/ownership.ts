import type { ResidentStore } from './store';

export class RuntimeOwnership {
  private readonly token: string;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private expiresAt = Date.now() + 30000;
  private lost = false;
  private renewing = false;

  constructor(
    private readonly store: ResidentStore,
    onLost: () => void,
    private readonly durable: () => Promise<void> = () => Promise.resolve()
  ) {
    this.token = store.acquireLease();
    this.heartbeat = setInterval(async () => {
      if (this.renewing || this.lost) return;
      this.renewing = true;
      const expiresAt = Date.now() + 30000;
      try {
        store.renewLease(this.token);
        await this.durable();
        if (!this.lost) this.expiresAt = expiresAt;
      } catch {
        this.lost = true;
        clearInterval(this.heartbeat);
        onLost();
      } finally {
        this.renewing = false;
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
