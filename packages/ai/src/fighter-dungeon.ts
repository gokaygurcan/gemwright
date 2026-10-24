import type { DecisionCoordinator } from './decisions';
import type { DungeonContext, RunRecord } from './dungeon-context';
import { dungeonTurn } from './dungeon-turn';
import type { FighterContext } from './fighter-context';
import { engageable, profileOf, recognised } from './fighter-prey';
import { fieldUpkeep, townNeed } from './fighter-trip';
import type { LifeContext } from './life';
import { distance } from './navigation';
import { readyForDungeons } from './progression';
import type { Entity } from './protocol/world';
import { trainSupportingSkill } from './skill-training';

// A fighter in a dungeon: its room work is to fight the nearest creature it can take, whatever the
// creature is (catalogs/monsters.json), heal in the field, and leave alone anything too strong.
export function fighterDungeon(
  ctx: FighterContext,
  deps: {
    defeat: (opponent: Entity) => Promise<void>;
    heal: () => Promise<void>;
    dress: () => Promise<void>;
    unreachable: Set<number>;
    record?: (record: RunRecord) => void;
  }
): DungeonContext {
  const { session, position } = ctx;
  // Creatures judged too strong this turn; left alone rather than re-inspected every step.
  const ignored = new Set<number>();
  return {
    session,
    serial: ctx.serial,
    terrain: ctx.terrain,
    template: ctx.template,
    checkpoint: ctx.checkpoint,
    deadline: ctx.deadline,
    home: ctx.home.town,
    position,
    check: ctx.check,
    phase: ctx.phase,
    log: ctx.log,
    persist: ctx.persist,
    navigate: ctx.navigate,
    dead: ctx.dead,
    recoversOwnCorpse: true,
    setRecovering: (on) => {
      ctx.state.recovering = on;
    },
    townNeed: () => townNeed(ctx),
    dress: deps.dress,
    afterRun: () => {
      ctx.trip.pending = 'return';
    },
    record: deps.record,
    work: async (radius, run) => {
      const candidates = ctx
        .nearby()
        .filter(
          (m) =>
            recognised(m.graphic) &&
            [3, 4, 5, 6].includes(m.notoriety ?? 0) &&
            !deps.unreachable.has(m.serial) &&
            !ignored.has(m.serial) &&
            !!m.position &&
            distance(position(), m.position) <= radius
        )
        .sort(
          (a, b) => distance(position(), a.position ?? position()) - distance(position(), b.position ?? position())
        );
      for (const candidate of candidates.slice(0, 3)) {
        try {
          await session.inspect(candidate.serial);
        } catch {
          continue;
        }
        const current = session.world.entities.get(candidate.serial);
        if (!current?.position || !profileOf(current)) continue;
        const verdict = engageable(ctx, current);
        if (!verdict.ok) {
          ignored.add(current.serial);
          if (run.room && !run.avoided.includes(run.room)) run.avoided.push(run.room);
          ctx.phase('dungeon-avoid', `Leaving ${current.name} alone: ${verdict.reason}`);
          continue;
        }
        await deps.defeat(current);
        run.kills++;
        ctx.persist();
        await fieldUpkeep(ctx, deps.heal);
        return true;
      }
      return false;
    }
  };
}

// A fighter's life between hunts (life.ts): its errands are the usual town trip, a dungeon phase
// runs through `dungeon`, and practice uses its supporting skills.
export function fighterLife(
  ctx: FighterContext,
  dungeon: DungeonContext,
  town: { sellLoot: () => Promise<void>; bank: () => Promise<void>; restock: () => Promise<void> },
  decisions?: DecisionCoordinator
): LifeContext {
  return {
    session: ctx.session,
    terrain: ctx.terrain,
    template: ctx.template,
    checkpoint: ctx.checkpoint,
    city: ctx.home.city,
    position: ctx.position,
    check: ctx.check,
    phase: ctx.phase,
    log: ctx.log,
    persist: ctx.persist,
    navigate: ctx.navigate,
    decisions,
    dungeon: () => dungeonTurn(dungeon, true),
    dungeonReady: () => readyForDungeons(ctx.session, ctx.template.archetype),
    errands: async () => {
      await town.sellLoot();
      await town.bank();
      await town.restock();
    },
    practise: (minutes) =>
      trainSupportingSkill({
        session: ctx.session,
        check: ctx.check,
        phase: ctx.phase,
        log: ctx.log,
        archetype: ctx.template.archetype,
        until: Math.min(ctx.deadline, Date.now() + minutes * 60_000),
        items: () => [...ctx.session.world.childrenOf(ctx.serial), ...ctx.session.world.childrenOf(ctx.backpack())]
      })
  };
}
