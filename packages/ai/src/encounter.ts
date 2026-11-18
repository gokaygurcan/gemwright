import { GHOST_BODIES } from '@gemwright/common/game/bodies';
import { creatures } from '@gemwright/common/game/rules';
import { Layer } from '@gemwright/network/layers';
import { hostileNotoriety } from '@gemwright/network/opcodes';
import type { PlayerSession } from '@gemwright/network/session';
import type { Entity } from '@gemwright/network/world';

import { Blocked } from './blocked';
import { canBeat, compareCombatOptions, forecastFight, PERCEPTION, selfState } from './fight-forecast';
import { type Treatment, takeTreatment, treatment } from './medicine';
import type { Mind } from './mind';
import { observedTerrain } from './observed-terrain';
import type { Option } from './options';
import { screenOf } from './perceive';
import type { Terrain } from './terrain';

const away = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type Answer = [question: string, answer: unknown];

// The answers a traced decision was given, given again in its simulation, in the order asked.
export class TapedEncounter {
  private readonly asked = new Map<string, unknown[]>();
  readonly unanswered = new Set<string>();

  constructor(tape: readonly Answer[]) {
    for (const [question, answer] of tape) {
      const answers = this.asked.get(question) ?? [];
      answers.push(answer);
      this.asked.set(question, answers);
    }
  }

  private answer<T>(question: string, otherwise: T): T {
    const answers = this.asked.get(question);
    if (!answers?.length) {
      this.unanswered.add(question);
      return otherwise;
    }
    return (answers.length > 1 ? answers.shift() : answers[0]) as T;
  }

  allows(serial: number) {
    return this.answer(`allows ${serial}`, false);
  }
  allowsKind(kind: string) {
    return this.answer(`allowsKind ${kind}`, false);
  }
  response() {
    return this.answer<Option | null | undefined>('response', undefined) ?? undefined;
  }
}

// The same encounter admission for choosing a target, approaching it and continuing a fight.
export class Encounter {
  private revision = -1;
  private readonly admitted = new Map<number, boolean>();
  escaping = false;
  // The answers it gives while a decision is traced (live.ts), for its simulation to give again.
  readonly tapes = new Set<Answer[]>();

  private told<T>(question: string, answer: T) {
    for (const tape of this.tapes) tape.push([question, answer]);
    return answer;
  }

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
            riskTolerance: this.mind.temper.boldness,
            joins: (mobile) => this.mind.threat(mobile.serial)
          })
      );
    }
    return this.told(`allows ${serial}`, this.admitted.get(serial) ?? false);
  }

  allowsKind(kind: string) {
    const world = screenOf(this.session);
    const here = world.position;
    const known = creatures.find((creature) => creature.type === kind);
    if (!known || !here) return this.told(`allowsKind ${kind}`, false);
    const target: Entity = {
      serial: -1,
      kind: 'mobile',
      graphic: known.bodies[0] ?? 0,
      ...(known.name ? { name: known.name } : {}),
      position: here
    };
    return this.told(
      `allowsKind ${kind}`,
      canBeat(this.session, selfState(this.session, false), target, {
        seen: [],
        riskTolerance: this.mind.temper.boldness
      })
    );
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

  // The nearest of those fighting it: what it turns on when there is no getting away.
  attacker(): number | undefined {
    const here = screenOf(this.session).position;
    return this.attackers()
      .filter((enemy) => here && enemy.position)
      .sort(
        (a, b) =>
          away(here ?? a.position ?? b.position ?? { x: 0, y: 0 }, a.position ?? { x: 0, y: 0 }) -
          away(here ?? a.position ?? { x: 0, y: 0 }, b.position ?? { x: 0, y: 0 })
      )[0]?.serial;
  }

  // The fight as it stands: every attacker together, put down one at a time (the quickest first),
  // each striking until it falls (ServUO's fight as combat-forecast.ts models it): the health it
  // would cost, and how hard they press meanwhile.
  private forecast() {
    const attackers = this.attackers();
    const status = screenOf(this.session).status;
    if (!attackers.length || !status?.maxHits) return undefined;
    const self = selfState(this.session, false);
    const fights = attackers
      .map((mobile) => {
        const one = forecastFight(this.session, mobile, {
          status: { hits: status.hits, maxHits: status.maxHits, armor: status.armor },
          weapon: self.held ?? self.spare
        });
        return {
          serial: mobile.serial,
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
    return { status, fights, total, loss };
  }

  // In danger when the fight as it stands costs more than it can take, against its health now, its
  // healing and its boldness.
  needsEscape() {
    const fight = this.forecast();
    if (!fight) return false;
    const verdict = compareCombatOptions({
      hits: fight.status.hits,
      maxHits: fight.status.maxHits,
      incomingPerSecond: fight.total,
      secondsToDefeat: fight.loss / Math.max(Number.EPSILON, fight.total),
      healAmount: fight.fights[0]?.heal ?? 0,
      riskTolerance: this.mind.temper.boldness
    });
    return verdict.action === 'flee-town';
  }

  // Guarded places to run to (the towns' banks, live.ts): the guards there end a fight it cannot.
  havens: readonly { x: number; y: number }[] = [];

  // In danger, running or fighting back, by what each costs: running, the blows taken all the way to
  // the nearest guarded place at the pace of the slower of it and them (nothing is outrun that steps
  // as fast); fighting back, the forecast's loss. Not every danger is equal: what the attackers are
  // (their health, their blows) is what the forecast weighs.
  private turning(): Option | undefined {
    const fight = this.forecast();
    const here = screenOf(this.session).position;
    if (!fight || !here) return undefined;
    const world = screenOf(this.session);
    const riding = [...world.entities.values()].some((e) => e.parent === world.serial && e.layer === Layer.Mount);
    const own = riding ? 0.1 : 0.2;
    const theirs = Math.min(
      ...fight.fights.map(
        (f) => creatures.find((c) => this.mind.call(f.serial)?.split('/').includes(c.type))?.speed ?? 0.2
      )
    );
    const haven = [...this.havens].sort((a, b) => away(here, a) - away(here, b))[0];
    // Outrunning them, only the first steps are taken under their blows.
    const exposed = theirs > own ? 3 : haven ? away(here, haven) * own : Number.POSITIVE_INFINITY;
    const running = fight.total * exposed;
    const quickest = fight.fights[0];
    if (haven && running < fight.loss)
      return {
        key: 'leave an unsafe encounter',
        id: 'escape',
        urgent: true,
        value: 0,
        seconds: exposed,
        steps: [{ verb: 'escape', to: haven }]
      };
    if (!quickest) return undefined;
    return {
      key: `fight back ${this.mind.call(quickest.serial)?.split('/')[0] ?? 'an attacker'}`,
      id: `fight back ${quickest.serial}`,
      urgent: true,
      value: 0,
      seconds: quickest.seconds,
      steps: [{ verb: 'fight', serial: quickest.serial, back: true }]
    };
  }

  treat(medicine: Treatment, going: () => boolean | Promise<boolean>) {
    return takeTreatment(this.session, this.mind, medicine, going);
  }

  response(): Option | undefined {
    return this.told('response', this.responding());
  }

  private responding(): Option | undefined {
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
    return this.turning();
  }

  // Hostile creatures it sees within `radius`, nearest first.
  private threats(radius: number) {
    const here = screenOf(this.session).position;
    if (!here) return [];
    return this.seen().filter(
      (enemy) =>
        !!enemy.position &&
        away(here, enemy.position) <= radius &&
        hostileNotoriety.includes(enemy.notoriety ?? 0) &&
        this.mind.threat(enemy.serial)
    );
  }

  // Away from the danger: to `to` when it is near and not past the attackers, else some 25 tiles
  // straight back from them; then on, away from whoever still strikes it, until nothing is hitting it
  // and no threat is within seven tiles, half a minute at most.
  async escape(
    navigate: (point: { x: number; y: number }, range: number) => Promise<boolean>,
    going: () => boolean | Promise<boolean>,
    to?: { x: number; y: number }
  ) {
    if (!(await going())) return false;
    if (screenOf(this.session).target) this.session.target(null);
    if (screenOf(this.session).warMode) this.session.setWarMode(false);
    this.escaping = true;
    const walk = async (point: { x: number; y: number }, range: number) => {
      if (this.stopping() || this.session.phase !== 'ready' || !(await going()))
        throw new Blocked('halted', 'Escape interrupted');
      if (!(await navigate(point, range)))
        throw new Blocked('unreachable', 'No observed route away from the encounter');
    };
    try {
      // A moment to take it in before running, as a person reacts.
      await Bun.sleep(330 + Math.random() * 670);
      const here = screenOf(this.session).position;
      const threats = this.threats(14);
      const centre = threats.length
        ? {
            x: threats.reduce((n, t) => n + (t.position?.x ?? 0), 0) / threats.length,
            y: threats.reduce((n, t) => n + (t.position?.y ?? 0), 0) / threats.length
          }
        : undefined;
      const past = (p: { x: number; y: number }) =>
        !!centre && !!here && (p.x - here.x) * (centre.x - here.x) + (p.y - here.y) * (centre.y - here.y) > 0;
      const near = to && here && away(here, to) < 250 && !past(to) ? to : undefined;
      const back =
        centre && here && this.terrain
          ? (() => {
              const length = Math.max(1, Math.hypot(here.x - centre.x, here.y - centre.y));
              return this.terrain.stand(
                Math.round(here.x + ((here.x - centre.x) / length) * 25),
                Math.round(here.y + ((here.y - centre.y) / length) * 25),
                here.z
              );
            })()
          : undefined;
      const safe = near ?? back ?? to;
      if (safe)
        await walk(safe, near ? 0 : 3).catch((error) => {
          if (!(error instanceof Blocked) || error.reason === 'halted') throw error;
        });
      const until = Date.now() + 30_000;
      let moveAt = 0;
      while (Date.now() < until && (this.attackers().length || this.threats(7).length)) {
        if (this.stopping() || this.session.phase !== 'ready') throw new Blocked('halted', 'Escape interrupted');
        const at = screenOf(this.session).position;
        if (this.attackers().length && Date.now() >= moveAt && this.terrain && at) {
          moveAt = Date.now() + 3000;
          const foes = this.threats(18);
          const clearance = (p: { x: number; y: number }) =>
            Math.min(...foes.map((f) => (f.position ? Math.hypot(p.x - f.position.x, p.y - f.position.y) : Infinity)));
          const candidates = [
            [0, -12],
            [12, -12],
            [12, 0],
            [12, 12],
            [0, 12],
            [-12, 12],
            [-12, 0],
            [-12, -12]
          ]
            .map(([dx = 0, dy = 0]) => this.terrain?.stand(at.x + dx, at.y + dy, at.z))
            .filter((p): p is NonNullable<typeof p> => !!p)
            .sort((a, b) => clearance(b) - clearance(a));
          for (const next of candidates.slice(0, 3)) {
            const moved = await walk(next, 1).then(
              () => true,
              (error) => {
                if (!(error instanceof Blocked) || error.reason === 'halted') throw error;
                return false;
              }
            );
            if (moved) break;
          }
        }
        await Bun.sleep(250);
      }
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
    const world = screenOf(this.session);
    const here = world.position;
    // Nothing can harm the dead (ServUO: no harm to a mobile that is not alive): a ghost's way is open.
    if (!here || GHOST_BODIES.has(world.entities.get(world.serial ?? -1)?.graphic ?? 0)) return result;
    for (const enemy of this.seen()) {
      const at = enemy.position;
      if (
        !at ||
        !this.mind.threat(enemy.serial) ||
        !hostileNotoriety.includes(enemy.notoriety ?? 0) ||
        this.allows(enemy.serial)
      )
        continue;
      // Ground closer to an encounter it cannot survive is not a shortcut. Its way out remains open.
      const radius = Math.min(PERCEPTION, away(here, at) - 1);
      for (let dx = -radius; dx <= radius; dx++)
        for (let dy = -radius; dy <= radius; dy++) result.add(`${at.x + dx},${at.y + dy}`);
    }
    return result;
  }
}
