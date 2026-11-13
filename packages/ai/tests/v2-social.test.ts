import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { HistoryEvent } from '../src/v2/history';
import { live } from '../src/v2/live';
import { Mind } from '../src/v2/mind';
import { perceive } from '../src/v2/perceive';
import { traitsOf } from '../src/v2/traits';
import { type Recorded, recorded } from './fixtures/v2/resident-run';
import { MARCY_SERIAL, type Social, startSocial } from './fixtures/v2/social-shard';

const GREET = 'double-click Marcy';
const button = (number: number) => `double-click Marcy > gump-response 7:${number}`;
const HARVEST = /^double-click my .+ > target land/;

const { traits } = traitsOf([], () => 0.5);

interface Resident {
  shard: Social;
  mind: Mind;
  events: HistoryEvent[];
}
const resident = (): Resident => {
  const shard = startSocial({ skills: { Mining: 75 } });
  const events: HistoryEvent[] = [];
  const mind = new Mind('resident', (event) => events.push(event), traits);
  mind.steps = (from, to) => Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
  return { shard, mind, events };
};

async function play(resident: Resident, stopWhen: (list: Recorded[]) => boolean, capMs = 60_000): Promise<Recorded[]> {
  const { shard, mind, events } = resident;
  let stop = false;
  const push = (event: HistoryEvent) => {
    events.push(event);
    const list = recorded(events);
    if (process.env.DEBUG_SOCIAL) {
      const last = list.at(-1);
      if (last && ['considered', 'plan-ended', 'outcome', 'predicted'].includes(last.kind))
        console.log(`[${last.kind}] ${JSON.stringify(last.data).slice(0, 460)}`);
    }
    if (!stop && stopWhen(list)) stop = true;
  };
  const stopPerception = perceive(
    shard.session as unknown as PlayerSession,
    'resident',
    (event) => {
      push(event);
      mind.observe(event);
    },
    shard.landAt
  );
  mind.awake = true;
  mind.acting = true;
  const started = Date.now();
  try {
    await live(
      shard.session as unknown as PlayerSession,
      mind,
      shard.terrain,
      shard.places,
      () => stop || Date.now() - started > capMs,
      (kind, data) => push({ resident: 'resident', at: Date.now(), kind, data })
    );
  } finally {
    stopPerception();
    shard.stop();
  }
  return recorded(events);
}

const doing = (entry: Recorded) => String(entry.data.doing ?? '');

test('meeting another player is an option like any other: weighed, taken, and learned, one person at a time', async () => {
  const player = resident();
  const list = await play(
    player,
    (current) =>
      // Enough once the coins have been asked for twice and the second answer taught it what to
      // expect of a third: the gift learned, the refusal learned.
      current.filter((entry) => entry.kind === 'plan-ended' && entry.data.id === `interact ${MARCY_SERIAL} 7:2`)
        .length >= 2 &&
      current.some(
        (entry) =>
          entry.kind === 'predicted' &&
          entry.data.key === button(2) &&
          (entry.data.expect?.gained?.Gold ?? 0) > 0 &&
          (entry.data.expect?.gained?.Gold ?? 0) < 3
      )
  );

  // It worked its seam first, with the stranger standing right there in view and the greeting on
  // offer all along: meeting her was optional, and it was not worth a dig.
  const busy = list.find(
    (entry) =>
      entry.kind === 'considered' &&
      (entry.data.options ?? []).some((option) => option.key === GREET) &&
      HARVEST.test(doing(entry))
  );
  expect(busy).toBeDefined();

  // With the seam worked out and nothing else to do, meeting her became the best thing on offer,
  // and it walked over and addressed her by her own name.
  const met = list.find((entry) => entry.kind === 'considered' && doing(entry) === GREET);
  expect(met).toBeDefined();
  if (!met) throw new Error('The stranger was never approached');
  expect(list.some((entry) => entry.kind === 'plan-ended' && entry.data.id === `greet ${MARCY_SERIAL}`)).toBe(true);

  // What she answered with became the options it weighed: her greeting paid nothing, so the next
  // thing it tried was the other button, and that one paid — the answer changed its choice.
  const buttons = list.filter(
    (entry) => entry.kind === 'plan-ended' && String(entry.data.id ?? '').startsWith(`interact ${MARCY_SERIAL} `)
  );
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  expect(String(buttons[0]?.data.id)).toBe(`interact ${MARCY_SERIAL} 7:1`);
  expect(String(buttons[1]?.data.id)).toBe(`interact ${MARCY_SERIAL} 7:2`);

  // The coins are part of what it learned that asking brought, and so is what she said.
  const gift = list.find(
    (entry) => entry.kind === 'outcome' && entry.data.key === button(2) && (entry.data.observed?.gained?.Gold ?? 0) >= 3
  );
  expect(gift).toBeDefined();
  expect(Object.keys(gift?.data.observed?.heard ?? {}).some((line) => line.includes('a few coins'))).toBe(true);

  // The second ask brought words and no coins, and its expectation of a third ask carries both:
  // what asking her has brought, weighed by how alike each asking was to now.
  const spent = list.find(
    (entry) =>
      entry.kind === 'outcome' &&
      entry.data.key === button(2) &&
      Object.keys(entry.data.observed?.heard ?? {}).some((line) => line.includes('nothing more'))
  );
  expect(spent).toBeDefined();
  const learned = list.find(
    (entry) =>
      entry.kind === 'predicted' &&
      entry.data.key === button(2) &&
      (entry.data.expect?.gained?.Gold ?? 0) > 0 &&
      (entry.data.expect?.gained?.Gold ?? 0) < 3
  );
  expect(learned).toBeDefined();
  if (!learned) throw new Error('Asking her again was never weighed');

  // Every attempt of it is kept under her name, not under people in general: what it learns of Marcy
  // is Marcy's.
  const keys = list
    .filter((entry) => entry.kind === 'outcome' || entry.kind === 'predicted')
    .map((entry) => String(entry.data.key ?? ''));
  expect(keys.some((key) => key.startsWith(button(2)))).toBe(true);
  expect(keys.some((key) => key === GREET)).toBe(true);
}, 180_000);
