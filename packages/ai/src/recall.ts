import { gold } from '@gemwright/common/items';
import { skillId } from '@gemwright/common/skills';

import { tally } from './activity';
import { reagentGraphics } from './mage-combat';
import { ensureSpell, shop } from './magery';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import type { PlayerSession } from './protocol/session';
import { buyOffer, findOffer } from './resident-offers';
import { RUNEBOOK } from './scribe';

// Recall, as players travelled: a caster marks a blank rune where it wants to return (Mark, sixth
// circle) and later recalls to it (Recall, fourth circle), each cast taking black pearl, blood moss
// and mandrake root. Blank runes come from the mage; the two spells only from scrolls, which no
// mage sells: looted, or bought from a resident scribe (scribe.ts). With a runebook, marked runes
// go into it (sixteen places) and the recall is cast from its page (RunebookGump button 50 + entry). Only a resident with the
// Magery for it does this, and only for its own marked places: the bank of its home town and of
// the towns it visits. A long trip that ends near one of them (work-areas.ts reachRegion, a
// stranded resident in moongate.ts) recalls instead of walking to a moongate.
const RECALL = { id: 32, scroll: 0x1f4c, mana: 11, magery: 50 };
const MARK = { id: 45, scroll: 0x1f59, mana: 20, magery: 70 };
const RUNE = 0x1f14;
const MAX_RUNES = 6;
const BOOK_RUNES = 16;
const RECALL_BUTTON = 50;
// Read when needed, not at load: this module sits in an import cycle with the travel code.
const reagents = () => ['BlackPearl', 'Bloodmoss', 'MandrakeRoot'].map((name) => reagentGraphics[name] ?? -1);
// FAILURES (spell-action.ts) plus "That location is blocked" and the rune-is-blank reply.
const REFUSED = new Set([500015, 502632, 500641, 502625, 502630, 500946, 501942, 502354]);

const magery = (session: PlayerSession) => session.world.skills.get(skillId('Magery'))?.base ?? 0;
const reagentsFor = (ctx: ProfessionContext) => reagents().every((graphic) => ctx.count(graphic) >= 1);

// One cast at a carried rune; true when the server did not refuse it within a few seconds.
async function castAt(ctx: ProfessionContext, spell: { id: number }, rune: number, done: () => boolean) {
  const { session } = ctx;
  if (session.world.target) return false;
  const seen = new Set(session.world.journal);
  const refused = () => session.world.journal.some((e) => !seen.has(e) && REFUSED.has(e.cliloc ?? 0));
  session.useSkill(spell.id, true);
  await session.waitFor(() => session.world.target !== null || refused(), 'spell cursor', 4000).catch(() => {});
  if (!session.world.target) return false;
  session.target({ serial: rune, x: 0, y: 0, z: 0, graphic: RUNE });
  await session.waitFor(() => done() || refused(), 'spell effect', 6000).catch(() => {});
  return done() && !refused();
}

// A spell not yet in the book: its scroll from a resident nearby (resident-offers.ts).
async function obtain(ctx: ProfessionContext, spell: { id: number; scroll: number }, label: string) {
  if (ctx.checkpoint.spells?.has.includes(spell.id) || ctx.count(spell.scroll) > 0) return;
  const offer = findOffer('scroll', ctx.position(), 60, ctx.count(gold), ctx.serial, label);
  if (offer) await buyOffer(ctx, offer).catch(() => false);
}

const runebook = (ctx: ProfessionContext) => ctx.carried().find((item) => item.graphic === RUNEBOOK);

// At a bank with no rune for it yet: marks one there (a blank rune bought for a few gold).
export async function markHere(ctx: ProfessionContext, label: string): Promise<boolean> {
  if (magery(ctx.session) < MARK.magery || !reagentsFor(ctx)) return false;
  ctx.checkpoint.runes ??= [];
  const runes = ctx.checkpoint.runes;
  const here = ctx.position();
  const book = runebook(ctx);
  if (runes.length >= (book ? BOOK_RUNES : MAX_RUNES) || runes.some((r) => distance(r, here) < 30)) return false;
  await obtain(ctx, MARK, 'mark scroll');
  await obtain(ctx, RECALL, 'recall scroll');
  if (!(await ensureSpell(ctx, MARK.id, MARK.scroll)) || !(await ensureSpell(ctx, RECALL.id, RECALL.scroll)))
    return false;
  const marked = new Set(runes.map((r) => r.serial));
  const blank = () => ctx.carried().find((item) => item.graphic === RUNE && !marked.has(item.serial));
  if (!blank() && !(await shop(ctx, new Map([[RUNE, 1]]), 30))) return false;
  const rune = blank();
  if (!rune || ctx.status().mana < MARK.mana) return false;
  ctx.phase('marking', `Marking a recall rune at ${label}`);
  const mana = ctx.status().mana;
  if (!(await castAt(ctx, MARK, rune.serial, () => ctx.status().mana <= mana - MARK.mana + 2))) return false;
  // Into the runebook when there is one: it holds the place as its next entry.
  const page = book ? runes.filter((r) => r.book === book.serial).length : undefined;
  if (book) await ctx.session.moveItem(rune.serial, book.serial).catch(() => {});
  const inBook = !!book && !ctx.session.world.entities.has(rune.serial);
  runes.push({ serial: rune.serial, label, x: here.x, y: here.y, ...(inBook ? { book: book.serial, page } : {}) });
  ctx.persist();
  ctx.log(`Marked a rune for ${label}`);
  return true;
}

// Recalls to a marked rune within `near` tiles of `point`; true when it arrived there.
export async function recallNear(ctx: ProfessionContext, point: { x: number; y: number }, near = 80) {
  const runes = (ctx.checkpoint.runes ?? []).filter((r) => distance(r, point) <= near);
  if (!runes.length || magery(ctx.session) < RECALL.magery || !reagentsFor(ctx) || ctx.status().mana < RECALL.mana)
    return false;
  const best = runes.sort((a, b) => distance(a, point) - distance(b, point))[0];
  if (best?.book !== undefined && best.page !== undefined) return recallFromBook(ctx, best);
  const rune = best && ctx.carried().find((item) => item.serial === best.serial);
  if (!best || !rune) {
    // A rune lost (died with it, or sold): forgotten, so it is marked again next time.
    ctx.checkpoint.runes = (ctx.checkpoint.runes ?? []).filter((r) => r !== best);
    return false;
  }
  ctx.phase('recalling', `Recalling to ${best.label}`);
  const arrived = await castAt(ctx, RECALL, rune.serial, () => distance(ctx.position(), best) <= 3);
  if (arrived) tally(ctx.session, 'recalls');
  return arrived;
}

// Recall from a runebook page: the book's gump, then that entry's Recall button.
async function recallFromBook(
  ctx: ProfessionContext,
  entry: { book?: number; page?: number; label: string; x: number; y: number }
) {
  const { session } = ctx;
  const book = ctx.carried().find((item) => item.serial === entry.book);
  if (!book || entry.page === undefined) {
    ctx.checkpoint.runes = (ctx.checkpoint.runes ?? []).filter((r) => r.book !== entry.book);
    return false;
  }
  const before = new Set(session.world.gumps.keys());
  session.use(book.serial);
  await session
    .waitFor(() => [...session.world.gumps.keys()].some((k) => !before.has(k)), 'runebook', 4000)
    .catch(() => {});
  const gump = [...session.world.gumps.values()].find((g) => !before.has(`${g.serial}:${g.id}`));
  if (!gump) return false;
  ctx.phase('recalling', `Recalling to ${entry.label} from my runebook`);
  session.replyGump(gump.serial, gump.id, RECALL_BUTTON + entry.page, []);
  await session.waitFor(() => distance(ctx.position(), entry) <= 3, 'recall arrival', 8000).catch(() => {});
  const arrived = distance(ctx.position(), entry) <= 3;
  if (arrived) tally(session, 'recalls');
  return arrived;
}

// The traveller for code that knows only the session (work-areas.ts, moongate.ts): registered
// by the shared turn (shared-turn.ts) for each resident that can use it.
const travellers = new WeakMap<PlayerSession, (point: { x: number; y: number }, near?: number) => Promise<boolean>>();
export const registerRecall = (ctx: ProfessionContext) =>
  travellers.set(ctx.session, (point, near) => recallNear(ctx, point, near).catch(() => false));
export const recallFor = (session: PlayerSession) => travellers.get(session);
