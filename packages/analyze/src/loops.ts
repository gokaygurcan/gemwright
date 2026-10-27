import { type Doc, link, noDatabase, num } from './doc';

// The loop guard's record (packages/ai/src/loop-watch.ts, the `loops` table the AI keeps for a
// day): every time a resident went in circles or stood five minutes without gaining anything or
// taking a step of its job, and was sent back to its job.
type Tables = Record<string, [string, number][]>;

export function loopsDoc(tables: Tables | undefined): Doc {
  if (!tables) return noDatabase('Loops');
  const loops = (tables.loops ?? [])
    .map(([key]) => {
      const [serial = '0', name = '', at = '0', ...reason] = key.split('|');
      return { serial: Number(serial), name, at: Number(at), reason: reason.join('|') };
    })
    .sort((a, b) => b.at - a.at);
  const byResident = new Map<string, { serial: number; count: number }>();
  for (const l of loops) byResident.set(l.name, { serial: l.serial, count: (byResident.get(l.name)?.count ?? 0) + 1 });
  return {
    title: 'Loops',
    subtitle: [
      `${loops.length} times in the last day a resident went in circles or stood still, and was sent back to its job.`
    ],
    blocks: [
      { kind: 'heading', text: 'By resident' },
      {
        kind: 'table',
        head: ['Resident', 'Loops'],
        numeric: [1],
        interactive: true,
        empty: 'None: nobody went in circles.',
        rows: [...byResident]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([name, r]) => [link(name, `/replay/${r.serial}`), num(r.count)])
      },
      { kind: 'heading', text: 'Every case, newest first (UTC)' },
      {
        kind: 'table',
        head: ['When', 'Resident', 'What happened'],
        empty: 'None.',
        rows: loops
          .slice(0, 500)
          .map((l) => [
            new Date(l.at).toISOString().slice(5, 16).replace('T', ' '),
            link(l.name, `/replay/${l.serial}`),
            l.reason
          ])
      }
    ]
  };
}
