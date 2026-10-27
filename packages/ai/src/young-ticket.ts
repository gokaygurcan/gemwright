import { BANKER_SPEECH_RANGE, offersBank, openBankBox } from './bank-gold';
import { pickLocation, townAt } from './locations';
import { distance } from './navigation';
import type { ProfessionContext } from './profession';
import { gumpCommands } from './protocol/gumps';
import type { PlayerSession } from './protocol/session';
import { residentContext } from './resident-context';
import { sellTo } from './vendor-trade';

// The young player ticket every new character gets (ServUO NewPlayerTicket, 0x14EF): two players
// put theirs together for a prize each. Using one's own ticket on the other's sends both owners the
// prize gump (1013011), wherever they are. So no meeting is needed: a holder near a bank puts its
// ticket down there and goes back to work; another holder walks to it and uses its own ticket on
// it. Each answers the gump on its next turn. The spellbook with every 1st to 4th circle spell
// (button 3) is the prize worth having: a caster keeps it, Recall included (no mage sells that
// scroll); anyone else sells it to a mage for 25 gold (SBMage), the price of a tool.
const TICKET = 0x14ef;
const SPELLBOOK = 0x0efa;
const PRIZE_GUMP = 1013011;
const SPELLBOOK_PRIZE = 3;
const RECLAIM_MS = 2 * 3_600_000;
// Tickets lying in wait, by their owner (the offer survives restarts in the checkpoint).
const offers = new Map<number, { ticket: number; x: number; y: number; at: number }>();
const tried = new WeakMap<PlayerSession, number>();

const prizeGump = (session: PlayerSession) =>
  [...session.world.gumps.values()].find((g) =>
    gumpCommands(g.layout).some((c) => c[0]?.startsWith('xmfhtml') && Number(c[5]) === PRIZE_GUMP)
  );
const casts = (ctx: Pick<ProfessionContext, 'template'>) =>
  [...(ctx.template.archetype?.primarySkills ?? []), ...(ctx.template.archetype?.supportingSkills ?? [])].includes(
    'Magery'
  );

// Answers an open prize gump with the spellbook and settles it at once (before any tidying could
// drop the wrong book): a caster keeps the new book and drops its old ones, re-checking its spells;
// anyone else keeps it to sell (sellPrize). True when a prize came.
async function choosePrize(session: PlayerSession, backpack: number) {
  const gump = prizeGump(session);
  if (!gump) return false;
  const books = () => session.world.childrenOf(backpack).filter((i) => i.graphic === SPELLBOOK);
  const before = new Set(books().map((b) => b.serial));
  session.replyGump(gump.serial, gump.id, SPELLBOOK_PRIZE, []);
  await session.waitFor(() => books().some((b) => !before.has(b.serial)), 'prize spellbook', 6000).catch(() => {});
  const prize = books().find((b) => !before.has(b.serial));
  const ctx = residentContext(session);
  if (!prize || !ctx) return !!prize;
  if (casts(ctx)) {
    for (const old of books().filter((b) => b.serial !== prize.serial))
      await session.dropAtFeet(old.serial).catch(() => {});
    ctx.checkpoint.spells = { checked: 0, has: [] };
    ctx.checkpoint.ticketPrize = 'done';
  } else ctx.checkpoint.ticketPrize = 'pending';
  delete ctx.checkpoint.ticketOffered;
  ctx.persist?.();
  return true;
}

// True when the turn went to the ticket: answering a prize, using another's ticket, offering its
// own, taking an old offer back, or selling the prize spellbook.
export async function ticketTurn(ctx: ProfessionContext): Promise<boolean> {
  const { session, checkpoint } = ctx;
  if (prizeGump(session)) {
    if (await choosePrize(session, ctx.backpack())) ctx.log('Chose the spellbook for my young player ticket');
    return true;
  }
  const ticket = ctx.carried().find((i) => i.graphic === TICKET);
  const offered = checkpoint.ticketOffered;
  if (offered) offers.set(ctx.serial, offered);
  if (!ticket) {
    // Its own ticket lies in wait: taken back after two hours untouched, when passing by.
    if (offered && Date.now() - offered.at > RECLAIM_MS && distance(offered, ctx.position()) <= 3) {
      const lying = session.world.entities.get(offered.ticket);
      if (lying?.position) await session.moveItem(lying.serial, ctx.backpack()).catch(() => {});
      offers.delete(ctx.serial);
      delete checkpoint.ticketOffered;
      ctx.persist();
      return true;
    }
    if (!offered) offers.delete(ctx.serial);
    if (!offered && !checkpoint.ticketPrize && (await fetchTicket(ctx))) return true;
    return sellPrize(ctx);
  }
  if ((tried.get(session) ?? 0) > Date.now()) return false;
  tried.set(session, Date.now() + 30 * 60_000);
  // Another's ticket waiting within reach: walk to it and use ours on it.
  const other = [...offers]
    .filter(([owner, o]) => owner !== ctx.serial && distance(o, ctx.position()) <= 60)
    .sort(([, a], [, b]) => distance(a, ctx.position()) - distance(b, ctx.position()))[0];
  if (other) {
    const [owner, offer] = other;
    ctx.phase('young-ticket', 'Using my young player ticket on one left by a resident');
    await ctx.navigate(offer, 1).catch(() => {});
    const lying = session.world.entities.get(offer.ticket);
    if (!lying?.position || distance(lying.position, ctx.position()) > 2) {
      ctx.log('Ticket swap: the ticket left for me is gone');
      offers.delete(owner);
      return true;
    }
    session.use(ticket.serial);
    await session.waitFor(() => session.world.target !== null, 'ticket cursor', 4000).catch(() => {});
    if (!session.world.target) return true;
    session.target({ serial: lying.serial, x: 0, y: 0, z: 0, graphic: lying.graphic });
    offers.delete(owner);
    await session.waitFor(() => !!prizeGump(session), 'ticket prize', 6000).catch(() => {});
    if (await choosePrize(session, ctx.backpack())) ctx.log('Chose the spellbook for my young player ticket');
    else ctx.log('Ticket swap: no prize offered');
    return true;
  }
  // None waiting: by a bank, its own goes down for the next holder who passes.
  const bank = pickLocation(townAt(ctx.position(), ctx.city), 'banker', ctx.position());
  if (!bank || distance(bank, ctx.position()) > 6) return false;
  await session.dropAtFeet(ticket.serial).catch(() => {});
  const lying = session.world.entities.get(ticket.serial);
  if (!lying?.position) return false;
  checkpoint.ticketOffered = { ticket: ticket.serial, x: lying.position.x, y: lying.position.y, at: Date.now() };
  offers.set(ctx.serial, checkpoint.ticketOffered);
  ctx.persist();
  ctx.log('Left my young player ticket by the bank for another young player');
  return true;
}

// ServUO puts the ticket in a new character's bank box: by a bank, it comes out once. A box
// without one (used or never given) ends the matter.
async function fetchTicket(ctx: ProfessionContext): Promise<boolean> {
  const { session } = ctx;
  if ((tried.get(session) ?? 0) > Date.now()) return false;
  const bank = pickLocation(townAt(ctx.position(), ctx.city), 'banker', ctx.position());
  if (!bank || distance(bank, ctx.position()) > 6) return false;
  tried.set(session, Date.now() + 30 * 60_000);
  for (const mobile of [...session.world.entities.values()]) {
    if (mobile.kind !== 'mobile' || !mobile.position || distance(ctx.position(), mobile.position) > BANKER_SPEECH_RANGE)
      continue;
    if (!(await offersBank(session, mobile.serial))) continue;
    const box = await openBankBox(ctx, mobile.serial).catch(() => undefined);
    if (box === undefined) continue;
    const ticket = session.world.childrenOf(box).find((i) => i.graphic === TICKET);
    if (ticket) {
      await session.moveItem(ticket.serial, ctx.backpack()).catch(() => {});
      ctx.log('Took my young player ticket out of the bank');
      tried.delete(session);
    } else ctx.checkpoint.ticketPrize = 'done';
    ctx.persist();
    return true;
  }
  return false;
}

// After the prize: anyone but a caster sells it to a mage.
async function sellPrize(ctx: ProfessionContext): Promise<boolean> {
  // Only after a prize was chosen; a book the resident already had is none of this.
  if (ctx.checkpoint.ticketPrize !== 'pending' || !ctx.carried().some((i) => i.graphic === SPELLBOOK)) return false;
  ctx.checkpoint.ticketPrize = 'done';
  ctx.persist();
  const town = townAt(ctx.position(), ctx.city);
  if (!pickLocation(town, 'mage', ctx.position())) return false;
  ctx.phase('selling', 'Selling the prize spellbook to a mage');
  const earned = await sellTo({ ...ctx, city: town }, 'mage', (i) => i.graphic === SPELLBOOK).catch(() => 0);
  ctx.log(earned ? `Sold the prize spellbook for ${earned} gold` : 'No mage bought the spellbook');
  return true;
}
