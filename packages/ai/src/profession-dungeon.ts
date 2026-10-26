import type { DungeonContext, DungeonRun, RunRecord } from './dungeon-context';
import { recoverDungeonCorpse } from './dungeon-death';
import { inAnyDungeon } from './dungeon-tools';
import { dungeonTurn } from './dungeon-turn';
import { pickLocation } from './locations';
import type { ProfessionContext } from './profession';
import { isGhost } from './resurrection';

// The tamer, bard and thief in dungeons. Each supplies a role: whether it is equipped to go (a
// companion, an instrument) and its work in a room. Runs, parties and deaths are the shared
// dungeon code's; the lifecycle (life.ts) decides when a run starts.
export interface DungeonRole {
  ready: (ctx: ProfessionContext) => boolean;
  work: (ctx: ProfessionContext, radius: number, run: DungeonRun) => Promise<boolean>;
  afterRun?: (ctx: ProfessionContext) => void;
}
// Paper-doll layers a recovered item may go back on (no hair, beard, backpack or mount).
const wornLayers = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 17, 18, 19, 20, 22, 23, 24]);

function professionDungeon(ctx: ProfessionContext, role: DungeonRole, record?: (r: RunRecord) => void) {
  const { session } = ctx;
  const dungeon: DungeonContext = {
    session,
    serial: ctx.serial,
    terrain: ctx.terrain,
    template: ctx.template,
    checkpoint: ctx.checkpoint,
    deadline: ctx.deadline,
    home: pickLocation(ctx.city, 'banker') ?? ctx.position(),
    position: ctx.position,
    check: ctx.check,
    phase: ctx.phase,
    log: ctx.log,
    persist: ctx.persist,
    navigate: ctx.navigate,
    dead: () => isGhost(ctx),
    recoversOwnCorpse: false,
    setRecovering: () => {},
    townNeed: () => {
      const status = ctx.status();
      if (status.weight >= status.maxWeight * 0.85)
        return { reason: `pack weight ${status.weight}/${status.maxWeight}`, hard: true };
      if (status.hits < status.maxHits * 0.4) return { reason: `health ${status.hits}/${status.maxHits}`, hard: true };
      return null;
    },
    // Whatever wearable came back from the corpse goes on its empty layer.
    dress: async () => {
      const worn = new Set(session.world.childrenOf(ctx.serial).map((item) => item.layer));
      for (const item of ctx.carried()) {
        const layer = ctx.terrain.tile(item.graphic, true).layer;
        if (!wornLayers.has(layer) || worn.has(layer)) continue;
        await session.equipItem(item.serial, layer).catch(() => {});
        worn.add(layer);
      }
    },
    afterRun: () => role.afterRun?.(ctx),
    record,
    work: (radius, run) => role.work(ctx, radius, run)
  };
  return dungeon;
}

// Resumes a run or recovers a corpse left in a dungeon; with `start` (the lifecycle chose a
// dungeon phase, life.ts) also starts one. True when the turn was spent on a dungeon.
export async function professionDungeonTurn(
  ctx: ProfessionContext,
  role: DungeonRole,
  record: ((r: RunRecord) => void) | undefined,
  start: boolean
): Promise<boolean> {
  const dungeon = professionDungeon(ctx, role, record);
  const below = !!inAnyDungeon(ctx.position());
  if (isGhost(ctx) && !below && !ctx.checkpoint.dungeon) return false;
  if (ctx.checkpoint.dungeonCorpse && !isGhost(ctx)) {
    await recoverDungeonCorpse(dungeon);
    return true;
  }
  return dungeonTurn(dungeon, start && !isGhost(ctx) && role.ready(ctx));
}
