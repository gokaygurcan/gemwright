import type { DungeonContext } from './dungeon-context';
import { endRun } from './dungeon-crawl';
import { handleDeath, rescueStep } from './dungeon-death';
import { leaveParty, musterOf, partyChat, partySay } from './dungeon-party';
import { dungeonWalker, Engaged } from './dungeon-tools';
import { dungeonNamed, exitStair, floorAt } from './dungeons';
import { Died, Retreat } from './fighter-context';
import { distance } from './navigation';

// A party member's dungeon run. It walks to the entrance on its own and says "here"; inside, it
// stays with the leader while it can see them and works beside them (fights, sends its pet, plays
// or steals). Where the leader went otherwise comes only from party chat: "in/down/up/out at x,y"
// before each stairway, and "at x,y" in answer to "where are you?". "<name> leads now" hands the
// party on; when the name is this character's own, it returns 'lead' and crawls as the leader.
// "gg all" or "head out" ends the run; a member lost for five minutes, out of supplies or dead
// without a party healer heads out on its own and says so.
const LOST_MS = 300_000;
const WAIT_AT_ENTRANCE_MS = 600_000;

export async function followDungeon(ctx: DungeonContext): Promise<'lead' | undefined> {
  const run = ctx.checkpoint.dungeon;
  const dungeon = dungeonNamed(run?.name);
  let leaderSerial = run?.party?.leader;
  if (!run || !dungeon || leaderSerial === undefined) {
    delete ctx.checkpoint.dungeon;
    return;
  }
  const { session, position, phase, check } = ctx;
  const { walk, takeStair, toEntrance } = dungeonWalker(ctx, () => !run.exiting);
  const self = session.world.entities.get(ctx.serial)?.name ?? '';
  const end = (outcome: string): undefined => {
    leaveParty(ctx);
    endRun(ctx, outcome);
  };
  let heard = run.startedAt;
  let ended = false;
  let promoted = false;
  let lastSeen: { x: number; y: number } | undefined;
  const orders: { verb: string; x: number; y: number }[] = [];
  const listen = () => {
    for (const entry of partyChat(ctx, heard)) {
      heard = entry.at;
      const text = entry.text ?? '';
      const heir = /^(.+) leads now/.exec(text)?.[1];
      if (heir) {
        if (heir === self) promoted = true;
        else leaderSerial = musterOf(run.party?.id)?.leader ?? leaderSerial;
      }
      if (entry.serial !== leaderSerial) continue;
      const order = /\b(in|down|up|out) at (\d+),(\d+)/.exec(text);
      if (order) orders.push({ verb: order[1] ?? '', x: Number(order[2]), y: Number(order[3]) });
      else {
        const at = /\bat (\d+),(\d+)/.exec(text);
        if (at && !/res pls/.test(text)) lastSeen = { x: Number(at[1]), y: Number(at[2]) };
      }
      if (/gg all|head out/i.test(text)) ended = true;
    }
  };
  const promote = (): 'lead' => {
    if (run.party) run.party = { ...run.party, role: 'leader', leader: ctx.serial };
    ctx.persist();
    phase('dungeon-lead', 'Leading the party on');
    return 'lead';
  };

  // Outside: meet at the entrance and go in when the leader says so.
  if (!floorAt(dungeon, position())) {
    if (run.exiting) return end('run ended before entering');
    const entry = await toEntrance(dungeon);
    if (!entry) return end('no entrance');
    partySay(ctx, 'here');
    phase('dungeon-gather', `Waiting at the ${dungeon.name} entrance for the leader`);
    const until = Date.now() + WAIT_AT_ENTRANCE_MS;
    while (Date.now() < until && !ended && !orders.some((order) => order.verb === 'in')) {
      check();
      listen();
      await Bun.sleep(1000);
    }
    if (!orders.some((order) => order.verb === 'in'))
      return end(ended ? 'party ended before entering' : 'party never went in');
    orders.splice(0, orders.findIndex((order) => order.verb === 'in') + 1);
    await takeStair({ at: entry.from, to: entry.to }, `Following the party into ${dungeon.name}`);
  }

  let lostSince: number | undefined;
  let askedAt = 0;
  while (Date.now() < ctx.deadline) {
    try {
      check();
      if (ctx.dead()) throw new Died('Died in the dungeon');
      listen();
      if (promoted) return promote();
      const floor = floorAt(dungeon, position());
      if (!floor) return end(run.exiting || ended ? 'climbed out' : 'left the dungeon');
      run.deepest = Math.max(run.deepest, floor.depth);
      const need = ctx.townNeed();
      if (!run.exiting && (ended || need?.hard)) {
        run.exiting = true;
        if (!ended) partySay(ctx, `heading out, ${need?.reason}`);
        ctx.persist();
      }
      if (await rescueStep(ctx, run)) continue;
      if (run.exiting) {
        const stair = exitStair(dungeon, floor, position());
        if (!stair) return end('no way up from this floor');
        await takeStair(stair, 'Climbing out');
        continue;
      }
      const leader = session.world.entities.get(leaderSerial);
      const visible =
        !!leader?.position &&
        distance(leader.position, position()) <= 18 &&
        floorAt(dungeon, { ...leader.position, z: leader.position.z ?? position().z })?.id === floor.id;
      if (visible && leader?.position) {
        lostSince = undefined;
        if (await ctx.work(8, run)) continue;
        if (distance(leader.position, position()) > 3) await walk(leader.position, 2);
        else await Bun.sleep(1000);
        continue;
      }
      // Out of sight: follow the oldest stairway the leader announced.
      const index = orders.findIndex((order) => order.verb !== 'in');
      const order = orders[index];
      if (order) {
        orders.splice(0, index + 1);
        const stair = floor.stairs
          .filter((s) => distance(s.at, order) <= 6)
          .sort((a, b) => distance(a.at, order) - distance(b.at, order))[0];
        if (stair) await takeStair(stair, `Following the party ${order.verb}`);
        continue;
      }
      if (await ctx.work(8, run)) continue;
      lostSince ??= Date.now();
      if (Date.now() - askedAt > 60_000) {
        partySay(ctx, 'where are you?');
        askedAt = Date.now();
      }
      if (lastSeen) {
        const target = lastSeen;
        lastSeen = undefined;
        phase('dungeon-regroup', `Heading to where the leader said they are, ${target.x},${target.y}`);
        await walk(target, 3);
      } else await Bun.sleep(1000);
      if (Date.now() - lostSince > LOST_MS) {
        run.exiting = true;
        partySay(ctx, 'lost you, heading out');
      }
    } catch (error) {
      if (error instanceof Engaged) continue;
      if (error instanceof Died || ctx.dead()) {
        if (await handleDeath(ctx, run, dungeon, ctx.recoversOwnCorpse)) continue;
        return end('died');
      }
      if (error instanceof Retreat) {
        run.exiting = true;
        partySay(ctx, 'heading out, too hurt');
        ctx.persist();
        continue;
      }
      throw error;
    }
  }
}
