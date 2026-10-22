import { tally } from './activity';
import { type DecisionCoordinator, decisionState } from './decisions';
import { type FighterContext, weaponSkill } from './fighter-context';
import { distance } from './navigation';
import type { Entity } from './protocol/world';

// Resident fighters (never crafters) form small hunting parties so three or four of them can take
// on undead none would fight alone. Every resident runs in this process, so this registry
// coordinates them; membership itself is a real ServUO party (invite cursor, then accept).
interface Party {
  leader: number;
  members: Set<number>;
  target?: number;
  // The plan the leader announced: who answered, who is ready, and when the leader called go.
  // `out` holds members sitting this fight out; the leader stops waiting for them.
  plan?: { target: number; at: number; answered: Set<number>; ready: Set<number>; out: Set<number>; go?: number };
}
const MAX_MEMBERS = 4;
const RANGE = 12;
const active = new Map<number, number>(); // fighter serial -> last seen hunting
const parties = new Map<number, Party>(); // member serial -> party
const invites = new Map<number, number>(); // invited serial -> leader serial
const strayed = new Map<number, number>();
const declined = new Map<number, number>(); // fighter serial -> no invitations until
const DECLINE_QUIET = 10 * 60_000;
const roles = new Map<number, string>(); // fighter serial -> weapon skill
export const roleOf = (serial: number) => roles.get(serial);

const fresh = (serial: number) => (active.get(serial) ?? 0) > Date.now() - 60_000;
export const partyOf = (serial: number) => parties.get(serial);

// Fellow members standing within `range` of a point, as this character observes them.
export function alliesNear(ctx: FighterContext, point: { x: number; y: number }, range = RANGE): Entity[] {
  const party = parties.get(ctx.serial);
  if (!party) return [];
  return [...party.members].flatMap((serial) => {
    const ally = serial === ctx.serial ? undefined : ctx.session.world.entities.get(serial);
    return ally?.position && distance(ally.position, point) <= range ? [ally] : [];
  });
}

const leave = (ctx: FighterContext, reason: string) => {
  const party = parties.get(ctx.serial);
  if (!party) return;
  party.members.delete(ctx.serial);
  parties.delete(ctx.serial);
  if (party.leader === ctx.serial) for (const member of party.members) parties.delete(member);
  try {
    ctx.session.party('leave', ctx.serial);
  } catch {
    // Leaving is best effort; the server also drops parties of disconnected members.
  }
  ctx.log(`Left the hunting party: ${reason}`);
};

// Whether to join `leader`'s party: Jev (when configured) weighs the party, health and how this
// character feels about the leader; the local rule joins. A refusal is spoken and declined in the
// party protocol, and the fighter is not invited again for a while.
async function answerInvite(ctx: FighterContext, leader: number, size: number, decisions?: DecisionCoordinator) {
  const name = ctx.session.world.entities.get(leader)?.name ?? 'a fighter';
  if (!decisions) return true;
  const present = () => !!ctx.session.world.entities.get(leader)?.position;
  const pick = await decisions.choose({
    kind: 'party-invite',
    checkpoint: ctx.checkpoint,
    observationRevision: ctx.session.world.revision,
    state: decisionState(ctx.session, ctx.template, ctx.checkpoint, {
      inviter: name,
      partySize: size,
      affinity: ctx.checkpoint.relationships[name]?.affinity ?? 0,
      health: Math.round((ctx.status().hits / Math.max(1, ctx.status().maxHits)) * 100) / 100
    }),
    candidates: [
      {
        id: 'join-party',
        description: `Join ${name}'s hunting party of ${size}: shared targets and fights agreed in speech.`,
        valid: present
      },
      {
        id: 'hunt-alone',
        description: `Politely decline ${name} and keep hunting alone; no invitations for ten minutes.`,
        valid: () => true
      }
    ],
    baseline: 'join-party',
    stillCurrent: present
  });
  const join = pick?.id !== 'hunt-alone';
  decisions.finish(ctx.checkpoint, pick, 'completed', join ? 'Joined the party' : 'Declined the invitation');
  return join;
}

// Called on every hunting decision: answer a pending invite, keep or leave a party, or as the
// lowest-serial fighter among nearby free fighters, invite them.
export async function organizeParty(ctx: FighterContext, decisions?: DecisionCoordinator) {
  const { session, serial } = ctx;
  active.set(serial, Date.now());
  roles.set(serial, weaponSkill(ctx.template));
  const leader = invites.get(serial);
  if (leader !== undefined) {
    invites.delete(serial);
    const party = parties.get(leader);
    if (
      party &&
      party.members.size < MAX_MEMBERS &&
      !(await answerInvite(ctx, leader, party.members.size, decisions))
    ) {
      session.party('decline', leader);
      declined.set(serial, Date.now() + DECLINE_QUIET);
      try {
        session.say('Thanks, but I will hunt alone for now.');
        tally(session, 'speech');
      } catch {
        // The refusal stands without the words.
      }
      ctx.log(`Declined a hunting party led by ${session.world.entities.get(leader)?.name ?? leader}`);
    } else if (party && party.members.size < MAX_MEMBERS) {
      session.party('accept', leader);
      party.members.add(serial);
      parties.set(serial, party);
      ctx.log(`Joined a hunting party led by ${session.world.entities.get(leader)?.name ?? leader}`);
    }
  }
  const party = parties.get(serial);
  if (party) {
    const together = alliesNear(ctx, ctx.position(), 20).length > 0;
    if (together) strayed.delete(serial);
    else if (!strayed.has(serial)) strayed.set(serial, Date.now());
    else if (Date.now() - (strayed.get(serial) ?? 0) > 120_000) leave(ctx, 'the others are out of sight');
    if (party.leader !== serial || party.members.size >= MAX_MEMBERS) return;
  }
  const free = ctx
    .nearby()
    .filter(
      (m) =>
        m.serial !== serial &&
        fresh(m.serial) &&
        !parties.has(m.serial) &&
        !invites.has(m.serial) &&
        (declined.get(m.serial) ?? 0) < Date.now() &&
        m.position &&
        distance(m.position, ctx.position()) <= RANGE
    );
  if (!party && (free.length < 2 || free.some((m) => m.serial < serial))) return;
  const own = party ?? { leader: serial, members: new Set([serial]) };
  parties.set(serial, own);
  for (const member of free.slice(0, MAX_MEMBERS - own.members.size)) {
    try {
      session.party('add');
      await session.waitFor(() => session.world.target !== null, 'party member cursor', 3000);
      session.target({ serial: member.serial, x: 0, y: 0, z: 0, graphic: member.graphic });
      invites.set(member.serial, serial);
    } catch (error) {
      if (session.phase !== 'ready') throw error;
      if (session.world.target) session.target(null);
    }
  }
  if (own.members.size === 1 && !free.some((m) => invites.get(m.serial) === serial)) parties.delete(serial);
  else ctx.log(`Leading a hunting party; invited ${free.length} nearby fighters`);
}

// Dungeon parties (dungeon-party.ts) form through the same ServUO party and share this registry,
// so fellow members count as allies when judging an opponent.
export function bindParty(leader: number, member: number) {
  const party = parties.get(leader) ?? { leader, members: new Set([leader]) };
  party.members.add(member);
  parties.set(leader, party);
  parties.set(member, party);
}
export function unbindParty(serial: number) {
  parties.get(serial)?.members.delete(serial);
  parties.delete(serial);
}

// The leader names the party's target; members follow it while it is visible.
export function partyTarget(ctx: FighterContext): Entity | undefined {
  const target = parties.get(ctx.serial)?.target;
  const mobile = target === undefined ? undefined : ctx.session.world.entities.get(target);
  return mobile?.position && (mobile.hits ?? 1) > 0 ? mobile : undefined;
}
export function setPartyTarget(ctx: FighterContext, target: number) {
  const party = parties.get(ctx.serial);
  if (party?.leader === ctx.serial) party.target = target;
}
