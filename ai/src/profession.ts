import type { CharacterTemplate } from './config';
import { converse } from './conversation';
import { threatsNear } from './danger';
import type { DecisionCoordinator } from './decisions';
import type { RunRecord } from './dungeon-context';
import { type LifeContext, lifeTurn } from './life';
import { serviceLocations } from './locations';
import { createNavigator, distance } from './navigation';
import { type DungeonRole, professionDungeonTurn } from './profession-dungeon';
import { readyForDungeons } from './progression';
import { Layer } from './protocol/layers';
import type { PlayerSession } from './protocol/session';
import type { Entity, Position, WorldView } from './protocol/world';
import { noticePeers } from './relationships';
import { isGhost, resurrectGhost } from './resurrection';
import { scavenge } from './scavenge';
import { isSetback, passSetback } from './setback';
import { trainSupportingSkill } from './skill-training';
import type { Checkpoint } from './store';
import { Terrain } from './terrain';

// Shared runtime for the newer professions (fisher, tailor, bard, tamer, thief): context, the main
// loop, setbacks, resurrection and idle supporting-skill training. A profession supplies one bounded
// `turn` of its own work; the loop repeats it until the deadline and never quits over the world.
export interface ProfessionOptions {
  session: PlayerSession;
  assets: string;
  template: CharacterTemplate;
  seconds: number;
  peers?: ReadonlyMap<number, string>;
  label?: string;
  checkpoint: Checkpoint;
  decisions?: DecisionCoordinator;
  save: (checkpoint: Checkpoint) => void;
  recordRun?: (record: RunRecord) => void;
  stopping?: () => boolean;
}
export interface ProfessionContext {
  session: PlayerSession;
  serial: number;
  terrain: Terrain;
  template: CharacterTemplate;
  checkpoint: Checkpoint;
  city: string;
  deadline: number;
  position: () => Position;
  status: () => NonNullable<WorldView['status']>;
  navigate: ReturnType<typeof createNavigator>;
  check: () => void;
  phase: (phase: string, note: string) => void;
  log: (message: string) => void;
  persist: () => void;
  backpack: () => number;
  carried: (backpack?: number) => Entity[];
  count: (graphic: number) => number;
  progress: Record<string, number>;
  // Practise a supporting skill for a while (craft and magery trainers get vendor access).
  practise: (minutes: number) => Promise<number>;
}

export async function runProfession(
  name: string,
  options: ProfessionOptions,
  turn: (ctx: ProfessionContext) => Promise<void>,
  // The profession's part in dungeon runs (profession-dungeon.ts), when it has one.
  dungeon?: DungeonRole
): Promise<{ stopped: string; progress: Record<string, number> }> {
  const { session, template } = options;
  const serial = session.world.serial;
  if (serial === null || session.world.map !== 1) throw new Error(`The ${name} supports Trammel`);
  const terrain = Terrain.shared(options.assets, 1);
  const deadline = Date.now() + options.seconds * 1000;
  const checkpoint = structuredClone(options.checkpoint);
  const city = template.creation.city.toLowerCase();
  const progress: Record<string, number> = {};
  const tag = options.label ? `${name}:${options.label}` : name;
  const log = (message: string) => console.error(`[${tag}] ${message}`);
  const persist = () => options.save(checkpoint);
  const phase = (value: string, note: string) => {
    checkpoint.goal = { kind: name, phase: value };
    noticePeers(session, checkpoint, options.peers, template.behavior.sociability);
    void converse({ session, checkpoint, template, city, peers: options.peers, decisions: options.decisions });
    checkpoint.memories = [...checkpoint.memories.slice(-49), { at: new Date().toISOString(), text: note }];
    persist();
    log(`${value}: ${note}`);
  };
  const position = () => {
    if (!session.world.position) throw new Error('Position is unknown');
    return session.world.position;
  };
  const status = () => {
    if (!session.world.status) throw new Error('Status is unknown');
    return session.world.status;
  };
  const check = () => {
    if (options.stopping?.() || Date.now() >= deadline) throw new Error(`${name} run duration reached`);
    if (session.phase !== 'ready') throw new Error(`${name} disconnected; reconnect before continuing`);
  };
  const backpack = () => {
    const pack = session.world.childrenOf(serial).find((item) => item.layer === Layer.Backpack);
    if (!pack) throw new Error('No observed backpack');
    return pack.serial;
  };
  const carried = (pack = backpack()) => session.world.childrenOf(pack);
  const count = (graphic: number) =>
    carried()
      .filter((item) => item.graphic === graphic)
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);
  const navigate = createNavigator({ session, terrain, check, phase, log });
  const items = () => [...session.world.childrenOf(serial), ...carried()];
  const ctx: ProfessionContext = {
    session,
    serial,
    terrain,
    template,
    checkpoint,
    city,
    deadline,
    position,
    status,
    navigate,
    check,
    phase,
    log,
    persist,
    backpack,
    carried,
    count,
    progress,
    practise: (minutes) =>
      trainSupportingSkill({
        session,
        check,
        phase,
        log,
        items,
        until: Math.min(deadline, Date.now() + minutes * 60_000),
        archetype: template.archetype,
        shop: { ...ctx, backpack, carried: (pack) => carried(pack) }
      })
  };
  // Work is `turn`; the lifecycle runs the other phases between turns.
  const life: LifeContext = {
    ...ctx,
    decisions: options.decisions,
    dungeon: dungeon && (() => professionDungeonTurn(ctx, dungeon, options.recordRun, true)),
    dungeonReady: () => !!dungeon?.ready(ctx) && readyForDungeons(session, template.archetype)
  };
  let stopped = `${name} run duration reached`;
  try {
    phase('reconcile', 'Reading current inventory and status; previous transactions are never replayed');
    await session.refreshStatus();
    await session.refreshSkills();
    while (Date.now() < deadline) {
      try {
        check();
        if (dungeon && (await professionDungeonTurn(ctx, dungeon, options.recordRun, false))) continue;
        if (await scavenge(ctx)) continue;
        if (isGhost(ctx)) {
          await resurrectGhost(ctx);
          continue;
        }
        if (status().hits < status().maxHits / 2) {
          await passSetback({ ...ctx, items, archetype: template.archetype }, 'health is below half');
          continue;
        }
        if (await lifeTurn(life)) continue;
        // Those who do not fight leave monsters to others: back to the town bank (danger.ts).
        const bank = serviceLocations(ctx.city, 'banker')[0];
        // Already at the bank, it stays put: a town is as safe as it gets, so the work goes on.
        const near = bank ? threatsNear(session, ctx.position(), 8) : [];
        if (!['tamer', 'bard', 'thief'].includes(name) && bank && near.length && distance(ctx.position(), bank) > 6) {
          const seen = near.map((m) => `${m.name ?? 'something'} (0x${m.graphic.toString(16)})`).join(', ');
          phase('avoiding', `Monsters about (${seen}); heading back to town`);
          await ctx.navigate(bank, 3).catch(() => {});
          await Bun.sleep(2000);
          continue;
        }
        const started = Date.now();
        await turn(ctx);
        // Every resident shares one event loop: a turn that found nothing to do (no spot, no target)
        // must not spin, so a turn lasts at least a second and always yields.
        await Bun.sleep(Math.max(0, 1000 - (Date.now() - started)));
      } catch (error) {
        if (!isSetback(session, error, !!options.stopping?.(), deadline)) throw error;
        await passSetback(
          { ...ctx, items, archetype: template.archetype },
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  } catch (error) {
    stopped = options.stopping?.()
      ? `${name} stopped by shutdown signal`
      : error instanceof Error
        ? error.message
        : String(error);
    phase('stopped', stopped);
    if (session.world.target && session.phase === 'ready') session.target(null);
  }
  return { stopped, progress };
}
