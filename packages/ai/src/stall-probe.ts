// Main-thread time per labelled entry point since the last sampler tick, so a late tick can be
// attributed to what actually ran. Measurement only; behavior is unchanged.
const slices = new Map<string, { ms: number; count: number; max: number }>();

export function timed<T>(label: string, run: () => T): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    const ms = performance.now() - start;
    const slice = slices.get(label);
    if (slice) {
      slice.ms += ms;
      slice.count++;
      if (ms > slice.max) slice.max = ms;
    } else slices.set(label, { ms, count: 1, max: ms });
  }
}

// Returns and clears the slices recorded since the previous call.
export function drainSlices() {
  const out = Object.fromEntries(
    [...slices].map(([label, s]) => [label, { ms: +s.ms.toFixed(2), count: s.count, max: +s.max.toFixed(2) }])
  );
  slices.clear();
  return out;
}
