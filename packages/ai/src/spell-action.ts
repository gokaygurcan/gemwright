import type { FighterContext } from './fighter-context';
import { groupMember } from './group-awareness';
import { distance } from './navigation';
import type { Entity } from './protocol/world';

export type SpellOutcome = 'confirmed' | 'failed' | 'unknown';
export interface SpellDefinition {
  id: number;
  name: string;
  circle: number;
}
export type SpellAim = Entity | { serial: number; graphic: number } | { x: number; y: number; z: number } | null;

export interface SpellObservation {
  hits: number;
  poison: number;
  strength: number;
  dexterity: number;
  intelligence: number;
  followers: number;
  targetHits?: number;
  targetPoison: boolean;
  targetDead: boolean;
}

export function observedSpellEffect(name: string, before: SpellObservation, after: SpellObservation): boolean {
  if (name === 'Cure' || name === 'Arch Cure') return before.poison > 0 && after.poison === 0;
  if (name === 'Heal' || name === 'Greater Heal') return after.hits > before.hits;
  if (name === 'Bless')
    return (
      after.strength > before.strength || after.dexterity > before.dexterity || after.intelligence > before.intelligence
    );
  if (name === 'Poison') return !before.targetPoison && after.targetPoison;
  if (name.startsWith('Summon ') || name.endsWith('Elemental')) return after.followers > before.followers;
  return (
    after.targetDead ||
    (before.targetHits !== undefined && after.targetHits !== undefined && after.targetHits < before.targetHits)
  );
}

const FAILURES = new Set([500015, 502632, 500641, 502625, 502630, 500946]);

export async function requestSpell(
  ctx: FighterContext,
  spell: SpellDefinition,
  aim: SpellAim,
  missing: Set<number>
): Promise<SpellOutcome> {
  const { session } = ctx;
  if (session.world.target) return 'unknown';
  ctx.check();
  const seen = new Set(session.world.journal);
  const failure = () =>
    session.world.journal.find(
      (entry) =>
        !seen.has(entry) &&
        (entry.serial === ctx.serial || entry.serial === 0xffffffff) &&
        FAILURES.has(entry.cliloc ?? 0)
    );
  const snapshot = (): SpellObservation => {
    const status = ctx.status();
    const target = aim && 'serial' in aim ? session.world.entities.get(aim.serial) : undefined;
    return {
      hits: target && aim && 'serial' in aim && aim.serial !== ctx.serial ? (target.hits ?? 0) : status.hits,
      poison:
        target && aim && 'serial' in aim && aim.serial !== ctx.serial
          ? (target.flags ?? 0) & 4
            ? 1
            : 0
          : (session.world.poisonLevel ?? 0),
      strength: status.strength,
      dexterity: status.dexterity,
      intelligence: status.intelligence,
      followers: status.followers ?? 0,
      targetHits: target?.hits,
      targetPoison: !!((target?.flags ?? 0) & 4),
      targetDead: !!aim && 'serial' in aim && session.world.deaths.has(aim.serial)
    };
  };
  const before = snapshot();
  const newMobiles = new Set(
    [...session.world.entities.values()].filter((entity) => entity.kind === 'mobile').map((entity) => entity.serial)
  );
  const wildEffect = () =>
    ['Blade Spirits', 'Energy Vortex'].includes(spell.name) &&
    [...session.world.entities.values()].some(
      (entity) =>
        entity.kind === 'mobile' &&
        !newMobiles.has(entity.serial) &&
        entity.name?.toLowerCase().replace(/^an? /, '') === spell.name.toLowerCase().replace(/s$/, '') &&
        entity.position &&
        aim &&
        !('serial' in aim) &&
        Math.max(Math.abs(entity.position.x - aim.x), Math.abs(entity.position.y - aim.y)) <= 3
    );
  const effect = () => observedSpellEffect(spell.name, before, snapshot()) || wildEffect();
  const wait = async (done: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (!done() && Date.now() < until) {
      ctx.check();
      await Bun.sleep(50);
    }
    ctx.check();
  };
  session.useSkill(spell.id, true);
  ctx.log(`Requested ${spell.name}`);
  try {
    if (aim !== null) {
      await wait(() => session.world.target !== null || !!failure(), 1000 + (2 + spell.circle) * 250);
      if (!failure() && session.world.target) {
        ctx.check();
        if ('serial' in aim) {
          const target =
            aim.serial === ctx.serial ? { ...ctx.position(), graphic: 0 } : session.world.entities.get(aim.serial);
          if (!target || (aim.serial !== ctx.serial && !('position' in target && target.position))) {
            session.target(null);
            return 'unknown';
          }
          if (aim.serial !== ctx.serial && ['Heal', 'Greater Heal', 'Cure', 'Arch Cure'].includes(spell.name)) {
            const ally = session.world.entities.get(aim.serial);
            if (
              !groupMember(session, aim.serial) ||
              !ally?.position ||
              ![1, 2].includes(ally.notoriety ?? 0) ||
              !ally.hits ||
              session.world.deaths.has(aim.serial) ||
              distance(ctx.position(), ally.position) > 10
            ) {
              session.target(null);
              return 'unknown';
            }
          }
          session.target({ serial: aim.serial, x: 0, y: 0, z: 0, graphic: aim.graphic });
        } else session.target({ serial: 0, ...aim, graphic: 0 });
      } else if (!failure()) return 'unknown';
    }
    await wait(() => !!failure() || effect(), aim === null ? 1500 + (3 + spell.circle) * 250 : 3500);
    const failed = failure();
    if (failed?.cliloc === 500015) missing.add(spell.id);
    const outcome = failed ? 'failed' : effect() ? 'confirmed' : 'unknown';
    ctx.log(`${spell.name}: ${outcome}${outcome === 'confirmed' ? ' (observed expected effect)' : ''}`);
    return outcome;
  } finally {
    if (session.phase === 'ready' && session.world.target) session.target(null);
  }
}
