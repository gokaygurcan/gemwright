import type { DungeonContext } from './dungeon-context';
import { handleDeath, rescueStep } from './dungeon-death';
import { dungeonWalker, Engaged, inAnyDungeon, newRun, runRecord, weakestPrimary } from './dungeon-tools';
import { chooseDungeon, dungeonNamed, exitStair, floorAt, rollGoal } from './dungeons';
import { Died, Retreat } from './fighter-context';
import { soloDungeons } from './progression';

// A dungeon run after UO Offline's crawler: walk to a home dungeon (or now and then a far one),
// go down its entrance, and on each floor roll the next room or stairway down. The role's work
// (fight, pet, music, theft) clears what it can in view and unvisited rooms are preferred;
// stairways down weigh more with skill, so depth thins out. A run timer, a town need or a retreat
// switches to exit mode: the nearest stairway up, floor by floor, defending only. Deaths follow
// dungeon-death.ts. A party leader crawls the same way and tells its members through `party`
// (dungeon-party.ts).
export const RUN_MINUTES = [20, 45];
// Share of chances a dungeon-ready resident spends in a dungeon instead of its usual ground.
export const DUNGEON_SHARE = 0.5;

// What a leader does for its party: announce a stairway and wait for the group, answer members
// who ask where it is, and close the party at the end. `descend` thins a short-handed party's depth.
export interface CrawlParty {
  gate: (verb: 'in' | 'down' | 'up' | 'out', at: { x: number; y: number }) => Promise<void>;
  tick: () => void;
  end: (outcome: string) => void;
  descend: number;
}

export const runMinutes = (random = Math.random) =>
  (RUN_MINUTES[0] ?? 20) + random() * ((RUN_MINUTES[1] ?? 45) - (RUN_MINUTES[0] ?? 20));

// Starts a solo run when both primaries are at 100.0; below that a party is mustered instead.
export function startSoloRun(ctx: DungeonContext, random = Math.random): boolean {
  if (!soloDungeons(ctx.session, ctx.template.archetype) || random() >= DUNGEON_SHARE) return false;
  const dungeon = chooseDungeon(ctx.home, random);
  const minutes = runMinutes(random);
  ctx.checkpoint.dungeon = newRun(dungeon.name, Date.now() + minutes * 60_000);
  ctx.persist();
  ctx.phase('dungeon-run', `Setting out alone for ${dungeon.name} for about ${Math.round(minutes)} minutes`);
  return true;
}

// Picks up a character found inside a dungeon with no run (a restart mid-run): it climbs out.
export function adoptDungeon(ctx: DungeonContext) {
  if (ctx.checkpoint.dungeon) return;
  const dungeon = inAnyDungeon(ctx.position());
  if (!dungeon) return;
  ctx.checkpoint.dungeon = newRun(dungeon.name, 0, true);
  ctx.persist();
}

// Records the run and clears it; the party hook speaks for a leader.
export function endRun(ctx: DungeonContext, outcome: string, party?: CrawlParty) {
  const run = ctx.checkpoint.dungeon;
  if (!run) return;
  party?.end(outcome);
  ctx.record?.(runRecord(ctx, run, outcome));
  delete ctx.checkpoint.dungeon;
  ctx.afterRun();
  ctx.persist();
  ctx.phase('dungeon-done', `Left ${run.name}: ${outcome}; ${run.kills} kills, deepest floor ${run.deepest}`);
}

export async function crawlDungeon(ctx: DungeonContext, party?: CrawlParty) {
  const run = ctx.checkpoint.dungeon;
  const dungeon = dungeonNamed(run?.name);
  if (!run || !dungeon) {
    delete ctx.checkpoint.dungeon;
    return;
  }
  const { position, phase, check } = ctx;
  const { walk, takeStair, toEntrance } = dungeonWalker(ctx, () => !run.exiting);
  const weakest = weakestPrimary(ctx);
  const end = (outcome: string) => endRun(ctx, outcome, party);

  // Outside: travel to the nearest entrance, gather the party, and go down it.
  if (!floorAt(dungeon, position())) {
    if (run.exiting) return end('run ended before entering');
    const entry = await toEntrance(dungeon);
    if (!entry) return end('no entrance');
    await party?.gate('in', entry.from);
    await takeStair({ at: entry.from, to: entry.to }, `Entering ${dungeon.name}`);
  }

  while (Date.now() < ctx.deadline) {
    try {
      check();
      if (ctx.dead()) throw new Died('Died in the dungeon');
      party?.tick();
      const floor = floorAt(dungeon, position());
      if (!floor) return end(run.exiting ? 'climbed out' : 'left the dungeon');
      run.deepest = Math.max(run.deepest, floor.depth);
      const need = ctx.townNeed();
      if (!run.exiting && (Date.now() >= run.until || need?.hard)) {
        run.exiting = true;
        ctx.persist();
        phase(
          'dungeon-exit',
          need?.hard ? `Leaving ${dungeon.name}: ${need.reason}` : `Run over; climbing out of ${dungeon.name}`
        );
      }
      if (await rescueStep(ctx, run)) continue;
      if (run.exiting) {
        const stair = exitStair(dungeon, floor, position());
        if (!stair) return end('no way up from this floor');
        await party?.gate(stair.toFloor === null ? 'out' : 'up', stair.at);
        await takeStair(stair, 'Climbing out');
        continue;
      }
      if (await ctx.work(12, run)) continue;
      const goal = rollGoal(dungeon, floor, {
        skill: weakest,
        visited: new Set(run.visited),
        avoided: new Set(run.avoided),
        descend: party?.descend
      });
      if (!goal) {
        run.exiting = true;
        continue;
      }
      if (goal.kind === 'descend') {
        await party?.gate('down', goal.stair.at);
        await takeStair(goal.stair, 'Going deeper');
        continue;
      }
      run.room = goal.room.name;
      phase('dungeon-room', `Crawling to ${goal.room.name} on floor ${floor.depth} of ${dungeon.name}`);
      await walk(goal.room.at, Math.max(2, goal.room.range));
      if (!(await ctx.work(12, run))) {
        run.visited = [...new Set([...run.visited, goal.room.name])];
        ctx.persist();
      }
    } catch (error) {
      if (error instanceof Engaged) continue;
      if (error instanceof Died || ctx.dead()) {
        if (await handleDeath(ctx, run, dungeon, ctx.recoversOwnCorpse)) continue;
        return end('died');
      }
      if (error instanceof Retreat) {
        run.exiting = true;
        ctx.persist();
        phase('dungeon-retreat', `${error.message}; climbing out of ${dungeon.name}`);
        continue;
      }
      throw error;
    }
  }
}
