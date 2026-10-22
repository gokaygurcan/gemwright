import type { DungeonContext } from './dungeon-context';
import type { CrawlParty } from './dungeon-crawl';
import { runMinutes } from './dungeon-crawl';
import { newRun, runRecord, weakestPrimary } from './dungeon-tools';
import { chooseDungeon } from './dungeons';
import { bindParty, unbindParty } from './hunting-party';
import { distance } from './navigation';
import { readyForDungeons } from './progression';

// Dungeon parties for residents between 80.0 and 100.0 primaries. A leader shouts LFG for a home
// dungeon in town; ready residents nearby answer, walk over, and accept a real party invitation.
// The party's size follows its weakest member: about five at 80.0, two or three near 100.0. After
// a few minutes the party goes with whoever came (descending less when short-handed), or is
// recorded as abandoned. This registry only coordinates who joins; once under way, members learn
// where the leader went from party chat ("down at x,y"), as players would.
const MUSTER_MS = 180_000;
const DUNGEON_SHARE = 0.5;
const REACH = 250;

interface Muster {
  id: string;
  leader: number;
  dungeon: string;
  at: { x: number; y: number };
  plannedSize: number;
  joining: Set<number>;
  invited: Set<number>;
  members: Map<number, string>;
  // Members that ended their own run (died, lost, out of supplies); the leader stops waiting.
  gone: Set<number>;
  status: 'mustering' | 'go' | 'abandoned' | 'ended';
  until: number;
}
const musters = new Map<string, Muster>();
export const musterOf = (id: string | undefined) => (id ? musters.get(id) : undefined);

export const partySize = (weakest: number) =>
  weakest >= 100 ? 1 : Math.min(5, Math.max(2, Math.round(5 - (weakest - 80) * 0.125)));

const nameOf = (ctx: DungeonContext) => ctx.session.world.entities.get(ctx.serial)?.name ?? 'resident';
export const say = (ctx: DungeonContext, line: string) => {
  try {
    ctx.session.say(line);
  } catch {
    // Speech is flavour; the plan stands without it.
  }
};
export const partySay = (ctx: DungeonContext, line: string) => {
  try {
    ctx.session.party('say', 0, line);
  } catch {
    // A lost message is like one nobody read; members ask again.
  }
};
// Party chat heard since `after` (ISO time), oldest first.
export const partyChat = (ctx: DungeonContext, after: string) =>
  ctx.session.world.journal.filter((entry) => entry.party && entry.at > after && entry.text);
export const leaveParty = (ctx: DungeonContext) => {
  unbindParty(ctx.serial);
  try {
    ctx.session.party('leave', ctx.serial);
  } catch {
    // The server also drops parties of members who leave its range or disconnect.
  }
};

// Joins a muster in reach, or (now and then) starts one. True when a party run was set.
export async function musterOrJoin(ctx: DungeonContext, random = Math.random): Promise<boolean> {
  if (!readyForDungeons(ctx.session, ctx.template.archetype)) return false;
  const open = [...musters.values()].find(
    (m) =>
      m.status === 'mustering' &&
      m.leader !== ctx.serial &&
      m.members.size + m.joining.size < m.plannedSize &&
      distance(m.at, ctx.position()) <= REACH
  );
  if (open) return join(ctx, open);
  if (random() >= DUNGEON_SHARE) return false;
  return lead(ctx, random);
}

async function lead(ctx: DungeonContext, random: () => number): Promise<boolean> {
  const { session, position } = ctx;
  // A dead leader that handed its last party on may still sit in that ServUO party.
  leaveParty(ctx);
  const dungeon = chooseDungeon(ctx.home, random);
  const m: Muster = {
    id: crypto.randomUUID(),
    leader: ctx.serial,
    dungeon: dungeon.name,
    at: { ...position() },
    plannedSize: partySize(weakestPrimary(ctx)),
    joining: new Set(),
    invited: new Set(),
    members: new Map([[ctx.serial, nameOf(ctx)]]),
    gone: new Set(),
    status: 'mustering',
    until: Date.now() + MUSTER_MS
  };
  musters.set(m.id, m);
  const shout = () => say(ctx, `LFG ${dungeon.name}, need ${m.plannedSize - m.members.size} more`);
  ctx.phase('dungeon-muster', `Looking for ${m.plannedSize - 1} companions for ${dungeon.name}`);
  shout();
  let shouted = Date.now();
  while (Date.now() < m.until && m.members.size < m.plannedSize) {
    ctx.check();
    for (const serial of m.joining) {
      const other = session.world.entities.get(serial);
      if (m.invited.has(serial) || !other?.position || distance(other.position, position()) > 10) continue;
      try {
        session.party('add');
        await session.waitFor(() => session.world.target !== null, 'party member cursor', 3000);
        session.target({ serial, x: 0, y: 0, z: 0, graphic: other.graphic });
        m.invited.add(serial);
      } catch (error) {
        if (session.phase !== 'ready') throw error;
        if (session.world.target) session.target(null);
      }
    }
    if (Date.now() - shouted > 60_000) {
      shout();
      shouted = Date.now();
    }
    await Bun.sleep(1000);
  }
  const party = {
    id: m.id,
    leader: m.leader,
    role: 'leader' as const,
    plannedSize: m.plannedSize,
    members: [...m.members.values()]
  };
  if (m.members.size < 2) {
    m.status = 'abandoned';
    musters.delete(m.id);
    ctx.record?.(runRecord(ctx, { ...newRun(dungeon.name, 0), party }, 'nobody came', false));
    say(ctx, 'nvm, maybe later');
    ctx.phase('dungeon-muster', `Nobody came for ${dungeon.name}; hunting as usual`);
    return false;
  }
  m.status = 'go';
  ctx.checkpoint.dungeon = { ...newRun(dungeon.name, Date.now() + runMinutes(random) * 60_000), party };
  ctx.persist();
  partySay(ctx, `all set, ${m.members.size} of us. meet at the ${dungeon.name} entrance`);
  ctx.phase('dungeon-run', `Leading ${m.members.size} of ${m.plannedSize} to ${dungeon.name}`);
  return true;
}

async function join(ctx: DungeonContext, m: Muster): Promise<boolean> {
  const { session, position } = ctx;
  leaveParty(ctx);
  m.joining.add(ctx.serial);
  say(ctx, 'me');
  ctx.phase('dungeon-join', `Answering the LFG for ${m.dungeon}`);
  try {
    while (m.status === 'mustering' && Date.now() < m.until + 10_000) {
      ctx.check();
      const leader = session.world.entities.get(m.leader);
      if (leader?.position && distance(leader.position, position()) > 3) await ctx.navigate(leader.position, 2);
      if (m.invited.has(ctx.serial) && !m.members.has(ctx.serial)) {
        // Give the invitation time to arrive before answering it.
        await Bun.sleep(1500);
        session.party('accept', m.leader);
        m.members.set(ctx.serial, nameOf(ctx));
        // The weakest member sets the size the party waits for.
        m.plannedSize = Math.max(m.plannedSize, partySize(weakestPrimary(ctx)));
        bindParty(m.leader, ctx.serial);
      }
      await Bun.sleep(1000);
    }
  } finally {
    m.joining.delete(ctx.serial);
  }
  if (m.status === 'go' && m.members.has(ctx.serial)) {
    const party = {
      id: m.id,
      leader: m.leader,
      role: 'member' as const,
      plannedSize: m.plannedSize,
      members: [...m.members.values()]
    };
    // The leader decides when the run ends; a member leaves earlier only for its own needs.
    ctx.checkpoint.dungeon = { ...newRun(m.dungeon, Date.now() + 3 * 3600_000), party };
    ctx.persist();
    return true;
  }
  if (m.members.delete(ctx.serial)) leaveParty(ctx);
  return false;
}

// The leader's side of the crawl: announce each stairway in party chat and wait for the group,
// answer "where are you?", and close the party when the run ends.
export function leaderParty(ctx: DungeonContext, id: string): CrawlParty | undefined {
  const m = musters.get(id);
  if (!m) return undefined;
  let heard = new Date().toISOString();
  const others = () => [...m.members.keys()].filter((serial) => serial !== ctx.serial && !m.gone.has(serial));
  const together = (range: number) =>
    others().every((serial) => {
      const other = ctx.session.world.entities.get(serial);
      return !!other?.position && distance(other.position, ctx.position()) <= range;
    });
  const tick = () => {
    for (const entry of partyChat(ctx, heard)) {
      heard = entry.at;
      if (entry.serial === ctx.serial) continue;
      if (/where/i.test(entry.text ?? '')) partySay(ctx, `at ${ctx.position().x},${ctx.position().y}`);
      if (/heading out|lost you|i died/i.test(entry.text ?? '')) m.gone.add(entry.serial);
    }
  };
  return {
    descend: Math.min(1, m.members.size / m.plannedSize),
    tick,
    gate: async (verb, at) => {
      partySay(ctx, `${verb} at ${at.x},${at.y}`);
      ctx.phase('dungeon-gather', `Waiting for the party before going ${verb}`);
      const until = Date.now() + (verb === 'in' ? 240_000 : 45_000);
      while (Date.now() < until && !together(6)) {
        ctx.check();
        tick();
        await Bun.sleep(1000);
      }
    },
    end: () => {
      // A leader that handed the party on while dead stays in the ServUO party: leaving would
      // disband it for everyone (Party.Remove of the leader).
      if (m.leader !== ctx.serial && m.status !== 'ended') return;
      partySay(ctx, m.status === 'ended' ? 'all dead, everyone head out' : 'gg all, heading back to town');
      m.status = 'ended';
      musters.delete(m.id);
      leaveParty(ctx);
    }
  };
}
