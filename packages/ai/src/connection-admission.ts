// A small admission queue avoids simultaneous account/game handshakes flooding the TCP proxy.
export class ConnectionAdmission {
  private active = 0;
  private nextAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly queue: { enter: () => void; reject: (error: Error) => void; cleanup: () => void }[] = [];
  constructor(
    private readonly limit = 3,
    private readonly intervalMs = 0
  ) {}
  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Connection cancelled');
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        waiter.cleanup();
        reject(new Error('Connection cancelled'));
        this.dispatch();
      };
      const waiter = {
        enter: () => {
          waiter.cleanup();
          this.active++;
          resolve();
        },
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort)
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(waiter);
      this.dispatch();
    });
    try {
      if (signal?.aborted) throw new Error('Connection cancelled');
      return await action();
    } finally {
      this.active--;
      this.dispatch();
    }
  }
  private dispatch() {
    if (!this.queue.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    while (this.active < this.limit && this.queue.length) {
      const remaining = this.nextAt - Date.now();
      if (remaining > 0) {
        if (!this.timer)
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.dispatch();
          }, remaining);
        return;
      }
      this.nextAt = Date.now() + this.intervalMs;
      this.queue.shift()?.enter();
    }
  }
}
export const connectionAdmission = new ConnectionAdmission(3, 500);
