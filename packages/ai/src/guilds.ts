import { tally } from './activity';
import { fundsStale, refreshFunds } from './bank-gold';
import { chaosOf } from './chaos';
import { foundGuild, guildNamed, guildOfMember, guilds, joinGuild, memberCount, type Side } from './guild-store';
import { diplomacyTurn } from './guild-wars';
import { awaitGump, awaitMessage, dismiss, findGump, mark, press } from './gump-flow';
import { craftContext, ownerOf, ownsHouse } from './housing';
import { type LifeContext, skillProgress } from './life';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';

// Guilds in ServUO's newer guild system (EJ): founded from the paperdoll's Guild button with a
// name, an abbreviation and the 25,000 gold fee from the bank (CreateGuildGump), members invited
// from the roster with a target cursor and answering the invitation gump (GuildRosterGump,
// GuildInvitationRequest). Founders are established residents (a house, good skills, savings,
// some boldness or warmth); each guild belongs to a side, Order or Chaos (guild-wars.ts), and
// takes members of its side up to its cap of 15 to 30.
export const FEE = 25_000;
// The guild menus by a cliloc only their layout has (every menu shows the three tab labels):
// the founding form, Resign (My Guild), Invite Player (roster), "Showing All Guilds"
// (diplomacy), Guild Relationship, Declaration of War and the invitation.
export const MENU = {
  create: 1062939,
  info: 3006115,
  roster: 1062992,
  diplomacy: 1063136,
  relationship: 1062975,
  war: 1062979,
  invitation: 1062946
} as const;
const FOUNDED = 1063238;
const NOT_FOUNDED = [1063000, 501153, 1063001, 1070884, 1070885];
const JOINED = 1063056;
const ACCEPTED = 1063249;
const REFUSED = [1063250, 1063049, 1063050, 1063051, 1063052, 503301, 1063334];

// Every resident's own side, from its temperament: the bold, the lone and the unruly lean Chaos.
export function sideOf(ctx: Pick<LifeContext, 'template' | 'session'>, name: string): Side {
  const { riskTolerance, cooperation } = ctx.template.behavior;
  const seed = ([...name].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 1000, 7) / 1000) * 0.4;
  return 0.4 * riskTolerance + 0.3 * (1 - cooperation) + 0.3 * chaosOf(ctx.session) + seed > 0.6 ? 'chaos' : 'order';
}

// Residents in this runtime and what others can tell about them, by serial (as players know each
// other); a leader recruits from those it sees.
interface Known {
  name: string;
  side: Side;
  sociability: number;
}
const known = new Map<number, Known>();
const pending = new Map<number, { guild: string; side: Side; at: number }>();
export const guildmates = (a: number, b: number) => {
  const first = known.get(a);
  const second = known.get(b);
  if (!first || !second) return false;
  const guild = guildOfMember(first.name);
  return !!guild && guild === guildOfMember(second.name);
};
export const knownResident = (serial: number) => known.get(serial);

const ORDER = {
  lead: ['Order of the', 'Knights of the', 'Wardens of the', 'Keepers of the', 'Guardians of the'],
  noun: ['Silver Oak', 'Dawn', 'Lantern', 'Crown', 'White Stag', 'Shield', 'Lion', 'Ankh', 'Morning Star', 'Rose']
};
const CHAOS = {
  lead: ['Cult of the', 'Brood of the', 'Legion of the', 'Children of the', 'Pact of the'],
  noun: ['Black Moon', 'Serpent', 'Ashen Skull', 'Raven', 'Ember', 'Thorn', 'Storm', 'Wolf', 'Void', 'Shade']
};
// A name and abbreviation not yet taken; no name contains another, so a diplomacy search by
// name finds exactly one guild.
function newName(side: Side, owner: string): { name: string; abbr: string } | undefined {
  const words = side === 'order' ? ORDER : CHAOS;
  const taken = guilds();
  const seed = [...owner].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  for (let i = 0; i < words.lead.length * words.noun.length; i++) {
    const noun = words.noun[(seed + i) % words.noun.length] ?? 'Dawn';
    const lead = words.lead[Math.floor((seed + i) / words.noun.length) % words.lead.length] ?? words.lead[0];
    const name = `${lead} ${noun}`;
    if (taken.some((g) => g.name.includes(name) || name.includes(g.name))) continue;
    const initials = noun
      .split(' ')
      .map((w) => w[0])
      .join('');
    const abbr = [`${initials}${side === 'order' ? 'O' : 'C'}`, `${noun.slice(0, 3).toUpperCase()}`]
      .map((a) => a.toUpperCase())
      .find((a) => !taken.some((g) => g.abbr === a));
    if (abbr) return { name, abbr };
  }
  return undefined;
}

export function closeGuildMenus(session: PlayerSession) {
  for (const cliloc of Object.values(MENU)) if (cliloc !== MENU.invitation) dismiss(session, cliloc);
}

// The guild menu (paperdoll Guild button): the founding form, or one's own guild.
export async function openGuildMenu(session: PlayerSession, want: number) {
  closeGuildMenus(session);
  session.openGuildMenu();
  return awaitGump(session, want, 'guild menu');
}

async function found(ctx: LifeContext, owner: string, side: Side): Promise<boolean> {
  const { session } = ctx;
  if (fundsStale(ctx.checkpoint)) await refreshFunds(craftContext(ctx), ctx.city);
  if ((ctx.checkpoint.funds?.bank ?? 0) < FEE + 5000) return false;
  const naming = newName(side, owner);
  if (!naming) return false;
  ctx.phase('guild', `Founding ${naming.name} [${naming.abbr}]`);
  const form = await openGuildMenu(session, MENU.create);
  const from = mark(session);
  press(session, form, 1, [
    { id: 5, text: naming.name },
    { id: 6, text: naming.abbr }
  ]);
  const heard = await awaitMessage(session, from, [FOUNDED, ...NOT_FOUNDED], 'guild founding');
  if (heard !== FOUNDED) {
    ctx.log(`Could not found ${naming.name} (${heard ?? 'no answer'})`);
    return false;
  }
  foundGuild({ ...naming, side, leader: owner, founded_at: Date.now(), cap: 15 + Math.floor(Math.random() * 16) });
  if (ctx.checkpoint.funds) ctx.checkpoint.funds.bank -= FEE;
  tally(session, 'guildsFounded');
  ctx.log(`Founded ${naming.name} for the ${side === 'order' ? 'Order' : 'Chaos'}`);
  ctx.persist();
  return true;
}

// Established enough to lead: a house, primary skills at 60 on average, 30,000 gold, and either
// boldness or warmth. Guilds stay few: about one per 20 residents, the sides kept even.
function canFound(ctx: LifeContext, owner: string, side: Side) {
  const { riskTolerance, sociability } = ctx.template.behavior;
  if (!ownsHouse(owner) || skillProgress(ctx) < 0.6 || Math.max(riskTolerance, sociability) < 0.5) return false;
  const all = guilds();
  const ours = all.filter((g) => g.side === side).length;
  return all.length < Math.max(2, Math.ceil(known.size / 20)) && ours <= all.length - ours;
}

// A leader in town invites residents of its side it can see, one at a time.
async function recruit(ctx: LifeContext, guild: string, side: Side) {
  const { session } = ctx;
  const row = guildNamed(guild);
  if (!row || memberCount(guild) >= row.cap) return false;
  const here = ctx.position();
  const candidate = [...session.world.entities.values()].find((m) => {
    const info = known.get(m.serial);
    return (
      m.kind === 'mobile' &&
      !!info &&
      !!m.position &&
      distance(here, m.position) <= 12 &&
      info.side === side &&
      !guildOfMember(info.name) &&
      Date.now() - (pending.get(m.serial)?.at ?? 0) > 3_600_000 &&
      Math.random() < 0.2 + 0.8 * info.sociability
    );
  });
  if (!candidate) return false;
  const name = known.get(candidate.serial)?.name ?? '';
  ctx.phase('guild', `Inviting ${name} into ${guild}`);
  const info = await openGuildMenu(session, MENU.info);
  press(session, info, 2);
  press(session, await awaitGump(session, MENU.roster, 'guild roster'), 8);
  await session.waitFor(() => session.world.target !== null, 'invitation cursor', 4000);
  pending.set(candidate.serial, { guild, side, at: Date.now() });
  const from = mark(session);
  session.target({ serial: candidate.serial, x: 0, y: 0, z: 0, graphic: candidate.graphic });
  const answer = await awaitMessage(session, from, [ACCEPTED, ...REFUSED], 'invitation answer', 20_000);
  closeGuildMenus(session);
  if (answer === ACCEPTED) joinGuild(name, guild);
  return true;
}

// Every resident answers guild invitations on its own, whatever it is doing: yes to a guild of
// its side when it has none, otherwise no.
const listening = new WeakSet<PlayerSession>();
function answerInvitations(session: PlayerSession, me: () => Known | undefined) {
  if (listening.has(session)) return;
  listening.add(session);
  const timer = setInterval(() => {
    if (session.phase === 'offline' || session.phase === 'failed') return clearInterval(timer);
    const gump = session.phase === 'ready' ? findGump(session, MENU.invitation) : undefined;
    const self = me();
    if (!gump || !self || session.world.serial === null) return;
    const offer = pending.get(session.world.serial);
    const yes = !!offer && offer.side === self.side && !guildOfMember(self.name);
    try {
      press(session, gump, yes ? 1 : 0);
    } catch {
      session.world.gumps.delete(`${gump.serial}:${gump.id}`);
      return;
    }
    if (!yes || !offer) return;
    const from = mark(session);
    void awaitMessage(session, from, [JOINED], 'joined guild', 8000).then((heard) => {
      if (heard !== JOINED) return;
      joinGuild(self.name, offer.guild);
      setTimeout(() => {
        if (session.phase === 'ready') session.guildSay('hail all, glad to be here');
      }, 3000);
    });
  }, 1500);
}

const nextTurn = new WeakMap<PlayerSession, number>();

// At a break point: registers the resident, answers invitations from now on, and gives leaders
// and would-be founders their turn about every ten minutes. True when the turn did something.
export async function guildTurn(ctx: LifeContext): Promise<boolean> {
  const { session } = ctx;
  const owner = ownerOf(ctx);
  const serial = session.world.serial;
  if (!owner || serial === null) return false;
  const side = sideOf(ctx, owner);
  known.set(serial, { name: owner, side, sociability: ctx.template.behavior.sociability });
  answerInvitations(session, () => known.get(serial));
  if ((nextTurn.get(session) ?? 0) > Date.now()) return false;
  nextTurn.set(session, Date.now() + 10 * 60_000);
  const guild = guildOfMember(owner);
  try {
    if (!guild) return canFound(ctx, owner, side) && (await found(ctx, owner, side));
    const row = guildNamed(guild);
    if (row?.leader !== owner) return false;
    return (await diplomacyTurn(ctx, row)) || (await recruit(ctx, guild, side));
  } catch (error) {
    if (session.phase !== 'ready') throw error;
    closeGuildMenus(session);
    ctx.log(`Guild business interrupted: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
