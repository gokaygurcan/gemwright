import { creatures } from '@gemwright/common/game/rules';
import { hostileNotoriety } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import type { Terrain } from '../terrain';
import { Blocked } from '../v1/blocked';
import { forecastFight } from '../v1/combat-forecast';
import { compareCombatOptions } from '../v1/combat-options';
import { escapeDanger } from '../v1/danger-response';
import { observedTerrain } from '../v1/observed-terrain';
import { registerTerrain } from '../v1/resident-context';
import { canBeat, harmless, PERCEPTION, selfState } from '../v1/self-state';
import { type Treatment, takeTreatment, treatment } from './medicine';
import type { Mind } from './mind';
import type { Option } from './options';
import { screenOf } from './perceive';

const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// The same encounter admission for choosing a target, approaching it and continuing a fight.
export class Encounter {
  private revision = -1;
  private readonly admitted = new Map<number, boolean>();
  escaping = false;

  constructor(
    private readonly session: PlayerSession,
    private readonly mind: Mind,
    private readonly terrain: Terrain | undefined,
    private readonly stopping: () => boolean = () => false
  ) {
    if (terrain?.directory) this.terrain = observedTerrain(terrain, session);
  }

  private seen() {
    const world = screenOf(this.session);
    const here = world.position;
    return [...world.entities.values()].filter(
      (entity) =>
        entity.kind === 'mobile' &&
        entity.serial !== world.serial &&
        entity.position &&
        here &&
        !world.deaths.has(entity.serial) &&
        away(here, entity.position) <= world.viewRange &&
        (!this.terrain || this.terrain.sight(here, entity.position))
    );
  }

  allows(serial: number) {
    const world = screenOf(this.session);
    if (this.revision !== world.revision) {
      this.admitted.clear();
      this.revision = world.revision;
    }
    if (!this.admitted.has(serial)) {
      const target = world.entities.get(serial);
      this.admitted.set(
        serial,
        !!target &&
          canBeat(this.session, selfState(this.session, false), target, {
            seen: this.seen(),
            riskTolerance: this.mind.temper.boldness
          })
      );
    }
    return this.admitted.get(serial) ?? false;
  }

  allowsKind(kind: string) {
    const world = screenOf(this.session);
    const here = world.position;
    const known = creatures.find((creature) => creature.type === kind);
    if (!known || !here) return false;
    const target: Entity = {
      serial: -1,
      kind: 'mobile',
      graphic: known.bodies[0] ?? 0,
      ...(known.name ? { name: known.name } : {}),
      position: here
    };
    return canBeat(this.session, selfState(this.session, false), target, {
      seen: [],
      riskTolerance: this.mind.temper.boldness
    });
  }

  // Who is fighting it: what has struck it and is still about, and what it is fighting itself.
  // Creatures that only stand about are no part of it, however many or strong.
  private attackers() {
    const world = screenOf(this.session);
    const here = world.position;
    return this.seen().filter(
      (enemy) =>
        (this.mind.struck(enemy.serial) || world.combatant === enemy.serial) &&
        !!here &&
        !!enemy.position &&
        away(here, enemy.position) <= PERCEPTION
    );
  }

  // In danger when the fight as it stands costs more than it can take: every attacker together, put
  // down one at a time (the quickest first), each striking until it falls, against its health now,
  // its healing and its boldness (ServUO's fight as combat-forecast.ts models it).
  needsEscape() {
    const attackers = this.attackers();
    const status = screenOf(this.session).status;
    if (!attackers.length || !status?.maxHits) return false;
    const self = selfState(this.session, false);
    const fights = attackers
      .map((mobile) => {
        const one = forecastFight(this.session, mobile, {
          status: { hits: status.hits, maxHits: status.maxHits, armor: status.armor },
          weapon: self.held ?? self.spare
        });
        return {
          seconds: one.remaining / Math.max(Number.EPSILON, one.outgoingPerSecond),
          pressure: one.incomingPerSecond,
          heal: one.healAmount
        };
      })
      .sort((a, b) => a.seconds - b.seconds);
    let pressure = fights.reduce((sum, f) => sum + f.pressure, 0);
    const total = pressure;
    let loss = 0;
    for (const fight of fights) {
      loss += fight.seconds * pressure;
      pressure -= fight.pressure;
    }
    const verdict = compareCombatOptions({
      hits: status.hits,
      maxHits: status.maxHits,
      incomingPerSecond: total,
      secondsToDefeat: loss / Math.max(Number.EPSILON, total),
      healAmount: fights[0]?.heal ?? 0,
      riskTolerance: this.mind.temper.boldness
    });
    return verdict.action === 'flee-town';
  }

  treat(medicine: Treatment, going: () => boolean | Promise<boolean>) {
    return takeTreatment(this.session, this.mind, medicine, going);
  }

  response(): Option | undefined {
    const medicine = treatment(this.mind);
    const danger = this.needsEscape();
    if (medicine && (!danger || medicine.kind === 'potion'))
      return {
        key: medicine.cure ? 'treat poison' : 'recover health',
        id: `treat ${JSON.stringify(medicine)}`,
        urgent: true,
        value: 0,
        seconds: medicine.kind === 'bandage' ? 8 : 1,
        steps: [{ verb: 'treat', treatment: medicine }]
      };
    if (!danger) return undefined;
    return {
      key: 'leave an unsafe encounter',
      id: 'escape',
      urgent: true,
      value: 0,
      seconds: 3,
      steps: [{ verb: 'escape' }]
    };
  }

  async escape(
    navigate: (point: { x: number; y: number }, range: number) => Promise<boolean>,
    going: () => boolean | Promise<boolean>
  ) {
    if (!(await going())) return false;
    if (screenOf(this.session).target) this.session.target(null);
    if (screenOf(this.session).warMode) this.session.setWarMode(false);
    if (this.terrain) registerTerrain(this.session, this.terrain);
    this.escaping = true;
    try {
      await escapeDanger(
        {
          session: this.session,
          check: () => {
            if (this.stopping() || this.session.phase !== 'ready') throw new Blocked('halted', 'Escape interrupted');
          },
          phase: () => {},
          navigate: async (point, range) => {
            if (!(await going())) throw new Blocked('halted', 'Escape cancelled');
            if (!(await navigate(point, range)))
              throw new Blocked('unreachable', 'No observed route away from the encounter');
          }
        },
        undefined
      );
      return !this.needsEscape();
    } catch (error) {
      if (error instanceof Blocked && error.reason === 'halted') return false;
      throw error;
    } finally {
      this.escaping = false;
    }
  }

  blocked() {
    const result = new Set<string>();
    if (this.escaping) return result;
    const here = screenOf(this.session).position;
    if (!here) return result;
    for (const enemy of this.seen()) {
      const at = enemy.position;
      if (!at || harmless(enemy) || !hostileNotoriety.includes(enemy.notoriety ?? 0) || this.allows(enemy.serial))
        continue;
      // Ground closer to an encounter it cannot survive is not a shortcut. Its way out remains open.
      const radius = Math.min(PERCEPTION, away(here, at) - 1);
      for (let dx = -radius; dx <= radius; dx++)
        for (let dy = -radius; dy <= radius; dy++) result.add(`${at.x + dx},${at.y + dy}`);
    }
    return result;
  }
}
