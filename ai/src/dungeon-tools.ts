import type { DungeonContext, DungeonRun, RunRecord } from './dungeon-context';
import { type Dungeon, dungeons, exitStair, floorAt, nearestEntry, type Stair, stairRoute } from './dungeons';
import { observedThreat } from './fighter-context';
import { recognised } from './fighter-prey';
import { moongates, travelByMoongate } from './moongate';
import { createNavigator, distance } from './navigation';
import { skillId } from './skills';

// Shared by every dungeon run: walking that stops for a closing monster, stairways, the way in
// and out, and travel to any point inside a dungeon (a corpse) over its stairways.
export type { DungeonRun, RunRecord };

// Farther than this, an entrance is reached through its moongate.
const WALKING_LIMIT = 300;

export class Engaged extends Error {}

export const inAnyDungeon = (at: { x: number; y: number; z: number }) =>
  dungeons.find((dungeon) => floorAt(dungeon, at));

export const weakestPrimary = (ctx: Pick<DungeonContext, 'session' | 'template'>) =>
  Math.min(
    ...(ctx.template.archetype?.primarySkills ?? []).map(
      (name) => ctx.session.world.skills.get(skillId(name))?.base ?? 0
    )
  );

export const newRun = (name: string, until: number, exiting = false): DungeonRun => ({
  name,
  until,
  startedAt: new Date().toISOString(),
  visited: [],
  avoided: [],
  exiting,
  deepest: 0,
  kills: 0,
  deaths: 0
});

// The report row for a finished run; the caller adds the resident's identity.
export function runRecord(ctx: DungeonContext, run: DungeonRun, outcome: string, assembled = true): RunRecord {
  const skills = Object.fromEntries(
    (ctx.template.archetype?.primarySkills ?? []).map((name) => [
      name,
      ctx.session.world.skills.get(skillId(name))?.base ?? 0
    ])
  );
  const self = ctx.session.world.entities.get(ctx.serial)?.name ?? 'resident';
  return {
    partyId: run.party?.id ?? null,
    role: run.party?.role ?? 'solo',
    dungeon: run.name,
    plannedSize: run.party?.plannedSize ?? 1,
    members: run.party
      ? run.party.members.map((name) => ({ name, skills: name === self ? skills : {} }))
      : [{ name: self, skills }],
    assembled,
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    outcome,
    deepest: run.deepest,
    kills: run.kills,
    deaths: run.deaths
  };
}

export function dungeonWalker(
  ctx: Pick<DungeonContext, 'session' | 'position' | 'phase' | 'check' | 'terrain' | 'log' | 'navigate'>,
  stopForThreats: () => boolean
) {
  const { session, position, phase, check } = ctx;
  const threatClose = () =>
    [...session.world.entities.values()].some(
      (m) =>
        m.kind === 'mobile' &&
        recognised(m.graphic) &&
        observedThreat(m, session.world.combatant) &&
        !!m.position &&
        distance(position(), m.position) <= 3
    );
  // Walking a dungeon stops for anything that closes in, so fights start on the character's terms.
  const walk = createNavigator({
    session,
    terrain: ctx.terrain,
    check,
    phase,
    log: ctx.log,
    onStep: () => {
      if (stopForThreats() && threatClose()) throw new Engaged('Monster closing in');
    }
  });
  const takeStair = async (stair: Pick<Stair, 'at' | 'to'>, label: string) => {
    phase('dungeon-stairs', `${label} at ${stair.at.x},${stair.at.y}`);
    try {
      await walk(stair.at, 0);
    } catch (error) {
      if (distance(position(), stair.to) > 3) throw error;
    }
    await session.waitFor(() => distance(position(), stair.to) <= 3, 'stairway teleport', 6000);
  };
  const toEntrance = async (dungeon: Dungeon) => {
    const entry = nearestEntry(dungeon, position());
    if (!entry) return undefined;
    phase('travelling-to-dungeon', `Heading to the ${dungeon.name} entrance at ${entry.from.x},${entry.from.y}`);
    if (distance(position(), entry.from) > WALKING_LIMIT && distance(position(), moongates[entry.gate]) > 2)
      await travelByMoongate(ctx, entry.gate);
    await ctx.navigate(entry.from, 4);
    return entry;
  };
  // The nearest stairway up, floor by floor, until the surface.
  const climbOut = async (dungeon: Dungeon, label = 'Climbing out') => {
    for (let floors = 0; floors < 12; floors++) {
      const floor = floorAt(dungeon, position());
      const stair = floor && exitStair(dungeon, floor, position());
      if (!stair) return;
      await takeStair(stair, label);
    }
  };
  // Any point, surface or dungeon: into the dungeon and down its stairways to the right floor.
  const travelTo = async (site: { x: number; y: number; z: number }, range: number) => {
    const dungeon = inAnyDungeon(site);
    const here = inAnyDungeon(position());
    if (here && here !== dungeon) await climbOut(here);
    if (!dungeon) return ctx.navigate(site, range);
    const target = floorAt(dungeon, site);
    if (!floorAt(dungeon, position())) {
      const entry = await toEntrance(dungeon);
      if (!entry) throw new Error(`No way into ${dungeon.name}`);
      await takeStair({ at: entry.from, to: entry.to }, `Entering ${dungeon.name}`);
    }
    const floor = floorAt(dungeon, position());
    const route = floor && target ? stairRoute(dungeon, floor.id, target.id) : undefined;
    if (!route) throw new Error(`No stairway route to ${site.x},${site.y} in ${dungeon.name}`);
    for (const stair of route) await takeStair(stair, 'Heading back down');
    await walk(site, range);
  };
  return { walk, takeStair, toEntrance, climbOut, travelTo };
}
