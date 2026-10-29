export interface NetworkTiming {
  label: string;
  ms: number;
}
const observers = new Set<(sample: NetworkTiming) => void>();

export function onNetworkTiming(observer: (sample: NetworkTiming) => void): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export function timed<T>(label: string, run: () => T): T {
  if (!observers.size) return run();
  const start = performance.now();
  try {
    return run();
  } finally {
    const sample = { label, ms: performance.now() - start };
    for (const observer of observers) {
      try {
        observer(sample);
      } catch {
        // A diagnostics consumer cannot fail a game connection or hide its original error.
      }
    }
  }
}
