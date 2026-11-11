import { isResident } from './activity';
import type { FighterContext } from './fighter-context';
import { distance } from './navigation';

// A player asks a fighter to group (speech "wanna group?", answered in conversation-answers.ts)
// and sends a party invite: a willing, healthy fighter accepts and keeps near the leader, fighting
// beside them as it would alone, for half an hour or until the leader has been gone two minutes.
// Then it leaves the party with a word, as a player would.
const STAY_MS = 30 * 60_000;
const GONE_MS = 2 * 60_000;
const groups = new WeakMap<object, { leader: number; until: number; seenAt: number; name: string }>();

// True when the turn went to keeping up with the player's party.
export async function playerPartyTurn(ctx: FighterContext): Promise<boolean> {
  const { session } = ctx;
  const invite = session.world.partyInvite;
  if (invite && Date.now() - invite.at < 60_000 && !isResident(invite.leader)) {
    session.world.partyInvite = null;
    const leader = session.world.entities.get(invite.leader);
    const willing =
      !groups.has(session) &&
      ctx.template.behavior.cooperation >= 0.4 &&
      ctx.status().hits >= ctx.status().maxHits * 0.6;
    const first = (leader?.name ?? '').split(' ')[0] || 'friend';
    if (!willing) {
      session.party('decline', invite.leader);
      session.say(`Not now, ${first}, sorry.`);
      return false;
    }
    session.party('accept', invite.leader);
    session.say(`Sure, ${first}. Lead on.`);
    groups.set(session, { leader: invite.leader, until: Date.now() + STAY_MS, seenAt: Date.now(), name: first });
    ctx.log(`Joined ${leader?.name ?? 'a player'}'s party`);
  }
  const group = groups.get(session);
  if (!group) return false;
  const leader = session.world.entities.get(group.leader);
  if (leader?.position) group.seenAt = Date.now();
  const over = Date.now() > group.until || Date.now() - group.seenAt > GONE_MS || !session.world.partyMembers.size;
  if (over) {
    groups.delete(session);
    session.party('leave');
    session.say(
      Date.now() > group.until
        ? `Have to go, ${group.name}. Thanks for the group!`
        : 'Lost my group; off on my own again.'
    );
    return false;
  }
  if (leader?.position && distance(ctx.position(), leader.position) > 3) {
    ctx.phase('grouping', `Keeping up with ${leader.name ?? 'my party leader'}`);
    await ctx.navigate(leader.position, 2).catch(() => {});
    return true;
  }
  return false;
}

export const inPlayerParty = (session: object) => groups.has(session);
