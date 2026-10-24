export const table = (head: string[], rows: (string | number)[][]) =>
  [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => ' --- ').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`)
  ].join('\n');

export const tenths = (value: number) => (value / 10).toFixed(1);

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0;
};

export const bump = <T>(counts: Map<T, number>, key: T, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by);
export const top = <T>(counts: Map<T, number>, n: number) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n);
export const list = <T>(counts: Map<T, number>, n: number) =>
  top(counts, n)
    .map(([key, count]) => `${key} ${count}`)
    .join(', ');
