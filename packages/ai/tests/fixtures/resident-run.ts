import type { PlayerSession } from '@gemwright/network/session';

import type { HistoryEvent } from '../../src/history';
import { live } from '../../src/live';
import { Mind } from '../../src/mind';
import { perceive } from '../../src/perceive';
import { traitsOf } from '../../src/traits';
import type { Shard } from './crafting-shard';

// What the recorded events carry, as far as these experiments read them.
export interface Recorded {
  index: number;
  kind: string;
  data: {
    id?: string;
    key?: string;
    result?: string;
    doing?: string;
    serial?: number;
    graphic?: number;
    skill?: string;
    verb?: string;
    gump?: number;
    button?: number;
    value?: { serial?: number; id?: number; layout?: string } | { serial?: number; price?: number; graphic?: number }[];
    options?: { key: string; rate: number }[];
    observed?: {
      gained?: Record<string, number>;
      lost?: Record<string, number>;
      skills?: Record<string, number>;
      heard?: Record<string, number>;
      killed?: number;
      died?: number;
      seconds?: number;
    };
    error?: { gained?: Record<string, number> };
    expect?: { gained?: Record<string, number> };
    n?: number;
    x?: number;
    y?: number;
    kinds?: string[];
    found?: boolean | string[];
  };
}
export const recorded = (events: HistoryEvent[]): Recorded[] =>
  events.map((event, index) => ({ index, kind: event.kind, data: event.data as Recorded['data'] }));

// A resident living on the shard through the real mind (live.ts, perceive.ts), until its observer
// says enough. Nothing here chooses for it: the mind deliberates and acts through the same code
// production runs.
export async function runResident(
  shard: Shard,
  stopWhen: (events: HistoryEvent[]) => boolean,
  capMs = 30_000
): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  let stop = false;
  const push = (event: HistoryEvent) => {
    events.push(event);
    if (!stop && stopWhen(events)) stop = true;
  };
  const { traits } = traitsOf([], () => 0.5);
  const mind = new Mind('resident', push, traits, [], ['Mining']);
  mind.acting = true;
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
  }
  return events;
}

// The id of the menu a gump event showed (the sell lists some events carry instead have none).
export const gumpId = (entry: Recorded) => (Array.isArray(entry.data.value) ? undefined : entry.data.value?.id);
