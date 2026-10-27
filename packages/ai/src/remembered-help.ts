import type { ProfessionContext } from './profession';
import type { JournalEntry } from './protocol/world-types';
import { rememberPartner } from './resident-memory';

// Who helped: a resident someone bandaged ("~1_NAME~ : Attempting to heal you", ServUO Bandage
// 1008078, the healer's name) remembers it. Trust (resident-memory.ts) and liking
// (relationships) rise, so the helper is greeted warmly and taken into parties and deals first
// (hunting-party.ts, market.ts).
const BANDAGED_BY = 1008078;
const read = new WeakMap<object, JournalEntry>();

export function noticeHelp(ctx: ProfessionContext) {
  const { session, checkpoint } = ctx;
  const journal = session.world.journal;
  const last = read.get(session);
  const from = last ? journal.lastIndexOf(last) + 1 : Math.max(0, journal.length - 20);
  const tail = journal.at(-1);
  if (tail) read.set(session, tail);
  for (const entry of journal.slice(from)) {
    if (entry.cliloc !== BANDAGED_BY) continue;
    const name = (entry.arguments ?? '').trim();
    const helper = [...session.world.entities.values()].find((m) => m.kind === 'mobile' && m.name === name);
    if (!name || !helper || helper.serial === ctx.serial) continue;
    rememberPartner(checkpoint, {
      partner: helper.serial,
      name,
      kind: 'rescue',
      detail: 'Bandaged me when I was hurt',
      id: `bandage:${helper.serial}:${Math.floor(Date.now() / 600_000)}`,
      result: 'completed'
    });
    const known = checkpoint.relationships[name];
    if (known) known.affinity = Math.min(1, known.affinity + 0.15);
    ctx.log(`${name} bandaged me; I will remember that`);
    ctx.persist();
  }
}

// How much this resident trusts someone (0 to 1), from what it remembers of them.
export const trusts = (ctx: Pick<ProfessionContext, 'checkpoint'>, serial: number) =>
  ctx.checkpoint.personal?.partners[serial]?.trust ?? 0;
