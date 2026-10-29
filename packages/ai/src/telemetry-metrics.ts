import type { TelemetryEvent } from './telemetry-schema';

const bounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, Infinity];
export class RuntimeMetrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { count: number; sum: number; max: number; buckets: number[] }>();
  private readonly starts = new Map<string, number>();
  increment(name: string, amount = 1) {
    const key = this.counters.has(name) || this.counters.size < 512 ? name : 'other';
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }
  duration(name: string, ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const key = this.histograms.has(name) || this.histograms.size < 64 ? name : 'other';
    const histogram = this.histograms.get(key) ?? { count: 0, sum: 0, max: 0, buckets: bounds.map(() => 0) };
    histogram.count++;
    histogram.sum += ms;
    histogram.max = Math.max(histogram.max, ms);
    const index = bounds.findIndex((bound) => ms <= bound);
    histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
    this.histograms.set(key, histogram);
  }
  observe(event: TelemetryEvent) {
    this.increment(`${event.component}.${event.type}.${event.result}`);
    if (event.type !== 'action_lifecycle' || !event.actionId) return;
    if (['proposed', 'authorized', 'dispatched', 'started'].includes(event.result)) {
      if (!this.starts.has(event.actionId)) this.starts.set(event.actionId, Date.parse(event.at));
      if (this.starts.size > 4096) this.starts.delete(this.starts.keys().next().value ?? '');
    } else if (['completed', 'failed', 'interrupted', 'timed-out', 'unconfirmed'].includes(event.result)) {
      const start = this.starts.get(event.actionId);
      if (start !== undefined) this.duration('action_ms', Date.parse(event.at) - start);
      this.starts.delete(event.actionId);
    }
  }
  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        [...this.histograms].map(([name, h]) => {
          const percentile = (fraction: number) => {
            let count = 0;
            for (let i = 0; i < bounds.length; i++) {
              count += h.buckets[i] ?? 0;
              if (count >= h.count * fraction) return bounds[i] === Infinity ? h.max : bounds[i];
            }
            return h.max;
          };
          return [
            name,
            {
              count: h.count,
              mean: h.sum / Math.max(1, h.count),
              max: h.max,
              p50: percentile(0.5),
              p95: percentile(0.95),
              p99: percentile(0.99)
            }
          ];
        })
      )
    };
  }
}
export const runtimeMetrics = new RuntimeMetrics();

const threats = new WeakMap<object, { at: number; recorded: Set<string> }>();
export function markThreat(session: object, active: boolean, at: number) {
  if (!active) {
    threats.delete(session);
    return;
  }
  if (!threats.has(session)) threats.set(session, { at, recorded: new Set() });
}
export function observeInterruption(
  session: object,
  event: { stage: string; kind: string; command?: string; at: number }
) {
  const threat = threats.get(session);
  const name =
    event.stage === 'interrupted'
      ? 'work_interrupt_ms'
      : event.kind === 'escape' && event.stage === 'authorized' && !event.command
        ? 'safety_authorize_ms'
        : undefined;
  if (!threat || !name || threat.recorded.has(name)) return;
  runtimeMetrics.duration(name, event.at - threat.at);
  threat.recorded.add(name);
}
