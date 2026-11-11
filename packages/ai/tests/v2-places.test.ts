import { expect, test } from 'bun:test';

import type { HistoryEvent } from '../src/v2/history';
import { Places } from '../src/v2/places';

// A rat that moves off its tile and a cat that vanishes in sight end their facts; a chair the
// resident walks away from is kept, with only the time it was watched.
test('a kind lifetime counts endings it witnessed, not things it walked away from', () => {
  const written: HistoryEvent[] = [];
  const places = new Places('r', (e) => written.push(e), { lifetimes: [], left: [] });
  const at = (x: number) => ({ x, y: 0, z: 0, map: 1 });
  const see = (t: number, serial: number, name: string, x: number) =>
    places.observe({ resident: 'r', at: t, kind: 'seen', data: { serial, is: [name], x, y: 0 }, where: at(0) });
  see(0, 1, 'Rat', 2);
  see(0, 2, 'Cat', 3);
  see(0, 3, 'WoodenChair', 4);
  places.observe({ resident: 'r', at: 10_000, kind: 'changed', data: { serial: 1, x: 3 }, where: at(0) });
  places.observe({ resident: 'r', at: 20_000, kind: 'gone', data: { serial: 2 }, where: at(0) });
  places.observe({ resident: 'r', at: 30_000, kind: 'gone', data: { serial: 3 }, where: at(30) });
  places.observe({ resident: 'r', at: 40_000, kind: 'asleep', data: {}, where: at(30) });

  expect(written.filter((e) => e.kind === 'left').map((e) => (e.data as { ended: boolean }).ended)).toEqual([
    true,
    false,
    false
  ]);
  expect(written.find((e) => e.kind === 'lifetimes')?.data).toEqual({
    Rat: { watched: 40, endings: 1 },
    Cat: { watched: 20, endings: 1 },
    WoodenChair: { watched: 30, endings: 0 }
  });
});
