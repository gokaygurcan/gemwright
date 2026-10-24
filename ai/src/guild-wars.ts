import { tally } from './activity';
import { HUMAN_BODIES } from './bodies';
import { chaosOf } from './chaos';
import type { FighterContext } from './fighter-context';
import { guarded } from './guards';
import {
  currentWar,
  declareWar,
  type GuildRow,
  guildNamed,
  guildOfMember,
  guilds,
  lastWarEnd,
  recordKill,
  type Side,
  setAlliance,
  startWar
} from './guild-store';
import { closeGuildMenus, MENU, openGuildMenu } from './guilds';
import { awaitGump, awaitMessage, mark, press } from './gump-flow';
import type { LifeContext } from './life';
import { distance } from './navigation';
import type { PlayerSession } from './protocol/session';
import type { Entity } from './protocol/world';

// Order against Chaos as two guild alliances at war (ServUO's EJ guild system has no Order or
// Chaos guild types). Each side's oldest guild leads its alliance ("The Order", "The Chaos"):
// in peace its leader proposes the alliance to the side's other guilds and their leaders accept
// (OtherGuildInfo: Request Alliance, the alliance's name asked by prompt, Accept Request). With
// `ai.wars` on, after a peace of 6 to 18 hours one side's leader declares war on the other for
// 24 to 72 hours (WarDeclarationGump) and the other accepts; ServUO ends the war on time. A guild
// cannot join an alliance at war, so newcomers join in the peace between wars.
let enabled = false;
export const setWars = (value: boolean) => {
  enabled = value;
};
export const warsEnabled = () => enabled;

const ALLIANCE: Record<Side, string> = { order: 'The Order', chaos: 'The Chaos' };
const PROPOSED = 1070750;
const NOT_PROPOSED = [1063416, 1063426, 1063427, 1063428, 1070747, 1063436, 1070758, 1063239];
const UPDATED = 1070752;
const WAR_SENT = 1070751;
const AT_WAR = 1070769;
const NO_WAR = [1063440, 1063239, 1070707];

// The first guild of a side leads its alliance.
export const sideLeader = (side: Side) => guilds().find((g) => g.side === side);

// One guild's relationship menu, found by name in the diplomacy list.
async function relationship(session: PlayerSession, other: string) {
  const info = await openGuildMenu(session, MENU.info);
  press(session, info, 3);
  press(session, await awaitGump(session, MENU.diplomacy, 'diplomacy'), 5, [{ id: 1, text: other }]);
  press(session, await awaitGump(session, MENU.diplomacy, 'diplomacy search'), 200);
  return awaitGump(session, MENU.relationship, 'guild relationship');
}

async function act(ctx: LifeContext, other: string, button: number, answers: number[], label: string, text?: string) {
  const { session } = ctx;
  const gump = await relationship(session, other);
  const from = mark(session);
  session.world.prompt = null;
  press(session, gump, button);
  if (text !== undefined) {
    await session.waitFor(() => session.world.prompt !== null, 'alliance name prompt', 4000).catch(() => {});
    if (session.world.prompt) session.answerPrompt(text);
  }
  const heard = await awaitMessage(session, from, answers, label, 10_000);
  closeGuildMenus(session);
  return heard;
}

// A leader's diplomacy at a break point: answers its side's alliance, then war business.
export async function diplomacyTurn(ctx: LifeContext, guild: GuildRow): Promise<boolean> {
  const head = sideLeader(guild.side);
  if (!head) return false;
  const war = currentWar();
  if (head.name !== guild.name) {
    if (guild.alliance_status !== 'proposed' || war) return false;
    ctx.phase('guild', `Joining ${ALLIANCE[guild.side]}`);
    const heard = await act(ctx, head.name, 16, [UPDATED], 'alliance acceptance');
    if (heard === UPDATED) {
      setAlliance(guild.name, ALLIANCE[guild.side], 'member');
      setAlliance(head.name, ALLIANCE[guild.side], 'member');
    }
    return true;
  }
  if (!war) {
    // Peace: the alliance takes in one more guild of the side.
    const outside = guilds().find((g) => g.side === guild.side && g.name !== guild.name && !g.alliance_status);
    if (outside) {
      ctx.phase('guild', `Proposing ${ALLIANCE[guild.side]} to ${outside.name}`);
      const first = guild.alliance_status !== 'member';
      const heard = await act(
        ctx,
        outside.name,
        2,
        [PROPOSED, ...NOT_PROPOSED],
        'alliance proposal',
        first ? ALLIANCE[guild.side] : undefined
      );
      if (heard === PROPOSED) setAlliance(outside.name, ALLIANCE[guild.side], 'proposed');
      return true;
    }
    const enemy = sideLeader(guild.side === 'order' ? 'chaos' : 'order');
    const rested = Date.now() - (lastWarEnd() ?? 0) > (6 + 12 * (1 - chaosOf(ctx.session))) * 3_600_000;
    if (!enabled || !enemy || !rested) return false;
    const hours = 24 + Math.floor(Math.random() * 49);
    ctx.phase('guild', `Declaring war on ${enemy.name} for ${hours} hours`);
    const gump = await relationship(ctx.session, enemy.name);
    press(ctx.session, gump, 1);
    const from = mark(ctx.session);
    press(ctx.session, await awaitGump(ctx.session, MENU.war, 'war declaration'), 1, [
      { id: 10, text: String(hours) },
      { id: 11, text: '0' }
    ]);
    const heard = await awaitMessage(ctx.session, from, [WAR_SENT, ...NO_WAR], 'war declaration');
    closeGuildMenus(ctx.session);
    if (heard === WAR_SENT) declareWar(guild.name, enemy.name, hours);
    return true;
  }
  if (war.status === 'declared' && war.opponent === guild.name) {
    ctx.phase('guild', `Accepting war with ${war.declarer}`);
    const heard = await act(ctx, war.declarer, 5, [AT_WAR], 'war acceptance');
    if (heard === AT_WAR) {
      startWar(war);
      tally(ctx.session, 'warsStarted');
      ctx.session.guildSay(`We are at war with ${war.declarer}! Meet them on the hunting grounds.`);
    }
    return true;
  }
  return false;
}

// Fighters at war take on enemy guild members (orange, notoriety 5) they meet outside guarded
// towns, healthy and not too many at once across the population; a fight's victim is recorded.
const MAX_FIGHTS = 8;
const fights = new Map<PlayerSession, { serial: number; name: string; until: number }>();
const humans = HUMAN_BODIES;

export function warOpponent(ctx: FighterContext): Entity | undefined {
  const { session } = ctx;
  const last = fights.get(session);
  const me = session.world.serial === null ? undefined : session.world.entities.get(session.world.serial)?.name;
  const guild = me ? guildOfMember(me) : undefined;
  if (last) {
    if (session.world.deaths.has(last.serial) && guild) {
      recordKill(me ?? '', last.name, guild, currentWar()?.id);
      tally(session, 'warKills');
      fights.delete(session);
    } else if (last.until < Date.now()) fights.delete(session);
  }
  if (!enabled || !guild || !guildNamed(guild) || currentWar()?.status !== 'active') return undefined;
  for (const [other, fight] of fights) if (fight.until < Date.now() || other.phase !== 'ready') fights.delete(other);
  const status = ctx.status();
  if (fights.size >= MAX_FIGHTS || status.hits < status.maxHits * 0.9 || guarded(session)) return undefined;
  const here = ctx.position();
  const enemy = [...session.world.entities.values()]
    .filter(
      (m) =>
        m.kind === 'mobile' &&
        humans.has(m.graphic) &&
        m.notoriety === 5 &&
        !!m.position &&
        !session.world.deaths.has(m.serial) &&
        distance(here, m.position) <= 12
    )
    .sort((a, b) => distance(here, a.position ?? here) - distance(here, b.position ?? here))[0];
  if (enemy) fights.set(session, { serial: enemy.serial, name: enemy.name ?? '', until: Date.now() + 3 * 60_000 });
  return enemy;
}
