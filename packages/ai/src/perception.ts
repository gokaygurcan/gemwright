import { GHOST_BODIES } from '@gemwright/common/bodies';
import type { WorldView } from '@gemwright/network/world';
import type { WorldChange, WorldField } from '@gemwright/network/world-observations';
import type { Entity } from '@gemwright/network/world-types';

import { type EntityObservation, perceiveEntity } from './perception-entity';
import { selfProjection } from './perception-self';
import { type Known, observed, type PerceivedEntity, type SelfPerception, unknown } from './perception-types';

const separation = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export class Perception {
  private readonly records = new Map<number, EntityObservation>();
  private readonly spatial = new Set<number>();
  private readonly visible = new Set<number>();
  private readonly swings = new Map<number, { target: number; at: number }>();
  private readonly invalidated = new Map<WorldField, number>();
  private readonly tombstones: { serial: number; at: number }[] = [];
  private readonly stamps = new Map<WorldField, number>();
  private readonly learnedSkills = new Map<number, { value: number; at: number }>();
  private readonly unsubscribe: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private failed = false;
  private facet: number | null;
  private projected: ReturnType<typeof selfProjection>;
  private life: Known<'alive' | 'dead'> = unknown('not-observed');
  readonly stats = { updates: 0, entitiesUpdated: 0, reconciliations: 0 };

  constructor(
    readonly world: WorldView,
    private readonly options: {
      now?: () => number;
      freshnessMs?: number;
      onError?: (error: unknown) => void;
      onReconcile?: () => void;
    } = {}
  ) {
    this.facet = world.map;
    this.projected = selfProjection(world);
    for (const [field, at] of world.observations.fieldAt) this.stamps.set(field, at);
    for (const [id, skill] of world.skills)
      this.learnedSkills.set(id, { value: skill.base, at: world.observations.skillAt.get(id) ?? 0 });
    if (
      (world.status?.hits ?? 0) > 0 &&
      world.observations.fieldAt.has('health') &&
      !GHOST_BODIES.has(world.entities.get(world.serial ?? -1)?.graphic ?? 0)
    )
      this.life = observed('alive', world.observations.fieldAt.get('health') ?? 0);
    this.reconcile();
    this.unsubscribe = world.observations.subscribe(
      (change) => this.update(change),
      (error) => {
        this.failed = true;
        options.onError?.(error);
      }
    );
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  get available() {
    return !this.closed && !this.failed && this.world.connected;
  }
  // A failed observation stream can become healthy again: the next reconciliation and status reply
  // prove it, so the failure is retried rather than bricking this session's model for good.
  revive() {
    if (!this.closed) this.failed = false;
  }

  start(intervalMs = 5000) {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      try {
        this.reconcile();
        this.options.onReconcile?.();
      } catch (error) {
        this.failed = true;
        this.options.onError?.(error);
      }
    }, intervalMs);
    this.timer.unref();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    this.visible.clear();
  }

  private capture(serial: number, at: number, spatial: boolean) {
    const entity = this.world.entities.get(serial);
    if (!entity) return;
    const previous = this.records.get(serial);
    const copied = { ...entity, position: entity.position ? { ...entity.position } : undefined };
    const facet =
      spatial || !previous
        ? this.world.map === null
          ? unknown('not-observed')
          : observed(this.world.map, at)
        : previous.facet;
    this.records.set(serial, { entity: copied, at, facet });
    this.stats.entitiesUpdated++;
    if (entity.position) this.spatial.add(serial);
    else this.spatial.delete(serial);
    this.updateVisibility(serial);
  }
  private remove(serial: number, at: number) {
    const record = this.records.get(serial);
    if (!record) return;
    this.records.set(serial, { ...record, removedAt: at });
    this.tombstones.push({ serial, at });
    while (this.tombstones.length > 1000) {
      const old = this.tombstones.shift();
      if (old && this.records.get(old.serial)?.removedAt === old.at) this.records.delete(old.serial);
    }
  }
  private updateVisibility(serial: number) {
    const record = this.records.get(serial);
    const here = this.world.position;
    const position = record?.entity.position;
    if (
      this.available &&
      record &&
      record.removedAt === undefined &&
      position &&
      here &&
      record.facet.kind === 'observed' &&
      record.facet.value === this.world.map &&
      separation(here, position) <= this.world.viewRange
    )
      this.visible.add(serial);
    else this.visible.delete(serial);
  }
  private refreshVisibility() {
    this.visible.clear();
    for (const serial of this.spatial) this.updateVisibility(serial);
  }
  private update(change: WorldChange) {
    this.stats.updates++;
    if (change.fields.length) {
      const next = selfProjection(this.world);
      for (const field of change.fields) {
        Object.assign(this.projected, { [field]: next[field] });
        this.stamps.set(field, change.at);
        this.invalidated.delete(field);
      }
    }
    for (const id of change.skills) {
      const skill = this.world.skills.get(id);
      if (skill) this.learnedSkills.set(id, { value: skill.base, at: change.at });
    }
    for (const serial of [...change.entities, ...change.contexts]) {
      this.capture(serial, !change.decoded ? (this.records.get(serial)?.at ?? 0) : change.at, change.spatial);
      const swing = this.world.swings.get(serial);
      if (swing) {
        if (!this.swings.has(serial) && this.swings.size >= 1000) {
          const oldest = this.swings.keys().next().value;
          if (oldest !== undefined) this.swings.delete(oldest);
        }
        this.swings.set(serial, { ...swing });
      }
    }
    for (const serial of change.removed) {
      const previous = this.records.get(serial);
      if (previous) this.remove(serial, change.at);
      this.spatial.delete(serial);
      this.visible.delete(serial);
    }
    if (
      this.facet !== this.world.map ||
      change.fields.some((f) => ['position', 'range', 'map'].includes(f)) ||
      !change.connected
    ) {
      this.facet = this.world.map;
      this.refreshVisibility();
    }
    if (
      change.events.some(
        (event) => event.type === 'self-death' || (event.type === 'entity-death' && event.serial === this.world.serial)
      )
    )
      this.life = observed('dead', change.at);
    else if (
      change.fields.includes('health') &&
      (this.world.status?.hits ?? 0) > 0 &&
      !GHOST_BODIES.has(this.world.entities.get(this.world.serial ?? -1)?.graphic ?? 0)
    )
      this.life = observed('alive', change.at);
  }

  reconcile() {
    this.stats.reconciliations++;
    const now = this.now();
    const next = selfProjection(this.world);
    for (const field of Object.keys(next) as WorldField[]) {
      const at = this.world.observations.fieldAt.get(field);
      const invalidAt = this.invalidated.get(field);
      if (at !== undefined && at > (invalidAt ?? this.stamps.get(field) ?? 0)) {
        this.stamps.set(field, at);
        this.invalidated.delete(field);
      } else if (JSON.stringify(this.projected[field]) !== JSON.stringify(next[field])) {
        this.invalidated.set(field, at ?? 0);
        this.stamps.delete(field);
      }
      Object.assign(this.projected, { [field]: next[field] });
    }
    for (const [id, at] of this.world.observations.skillAt) {
      const skill = this.world.skills.get(id);
      if (skill) this.learnedSkills.set(id, { value: skill.base, at });
    }
    for (const [serial, source] of this.world.entities) {
      const previous = this.records.get(serial);
      const old = previous?.entity;
      if (
        !old ||
        previous.removedAt !== undefined ||
        old.graphic !== source.graphic ||
        old.parent !== source.parent ||
        old.layer !== source.layer ||
        old.amount !== source.amount ||
        old.name !== source.name ||
        old.notoriety !== source.notoriety ||
        old.hits !== source.hits ||
        old.properties !== source.properties ||
        old.position?.x !== source.position?.x ||
        old.position?.y !== source.position?.y ||
        old.position?.z !== source.position?.z
      )
        this.capture(serial, this.world.observations.entityAt.get(serial) ?? previous?.at ?? 0, !previous);
    }
    for (const [serial, record] of this.records) {
      if (!this.world.entities.has(serial) && record.removedAt === undefined) {
        this.remove(serial, now);
        this.spatial.delete(serial);
        this.visible.delete(serial);
      }
      if (record.removedAt !== undefined && now - record.removedAt > 5 * 60_000) this.records.delete(serial);
    }
    for (const [serial, swing] of this.world.swings) if (now - swing.at < 8000) this.swings.set(serial, { ...swing });
    for (const [serial, swing] of this.swings) if (now - swing.at > 8000) this.swings.delete(serial);
    this.refreshVisibility();
  }
  private fact<T>(field: WorldField, value: T | null | undefined, expires = true): Known<T> {
    if (!this.available) return unknown(this.failed ? 'perception-failed' : 'disconnected', this.stamps.get(field));
    const at = this.stamps.get(field);
    if (value == null || at === undefined) return unknown('not-observed');
    if (expires && this.now() - at > (this.options.freshnessMs ?? 60_000)) return unknown('stale', at);
    return observed(value, at);
  }
  self(): SelfPerception {
    const state = this.projected;
    return {
      available: this.available,
      life: this.available ? this.life : unknown('disconnected'),
      position: this.fact('position', state.position, false),
      facet: this.fact('map', state.map, false),
      health: this.fact('health', state.health),
      mana: this.fact('mana', state.mana),
      stamina: this.fact('stamina', state.stamina),
      weight: this.fact('weight', state.weight),
      reportedGold: this.fact('gold', state.gold),
      poison: this.fact('poison', state.poison, false),
      damagedRecently: this.damagedRecently(),
      underAttack: this.underAttack()
    };
  }
  // Recent while a recorded loss or a damage packet for this character falls inside the window; the
  // live protocol history is the source of truth, so no bookkeeping can drift away from it.
  damagedRecently(now = this.now()) {
    if (!this.available) return false;
    const damage = this.world.damage.get(this.world.serial ?? -1);
    if (damage?.amount && now >= damage.at && now - damage.at < 8000) return true;
    return this.world.healthChanges.some((change) => change.damage > 0 && now >= change.at && now - change.at < 8000);
  }
  underAttack() {
    if (!this.available) return false;
    const now = this.now();
    return [...this.swings].some(
      ([serial, swing]) =>
        serial !== this.world.serial && swing.target === this.world.serial && now >= swing.at && now - swing.at < 3000
    );
  }
  viewRange() {
    if (!this.available) return unknown('disconnected');
    const at = this.stamps.get('range');
    return at === undefined
      ? { kind: 'reference' as const, value: 18, source: 'classic client default; not negotiated' }
      : observed(this.projected.range, at);
  }
  skill(id: number): Known<number> {
    if (!this.available) return unknown('disconnected');
    const skill = this.learnedSkills.get(id);
    return skill && skill.at > 0 ? observed(skill.value, skill.at) : unknown('not-observed');
  }
  entity(serial: number): PerceivedEntity | undefined {
    const record = this.records.get(serial);
    if (!record) return;
    const owned = record.entity.parent !== undefined && this.inventory().some((e) => e.serial === serial);
    return perceiveEntity(
      this.world,
      record,
      this.available && this.visible.has(serial),
      this.now(),
      this.swings.get(serial),
      owned
    );
  }
  visibleEntities(kind?: Entity['kind']): PerceivedEntity[] {
    if (!this.available) return [];
    return [...this.visible].flatMap((serial) => {
      const record = this.records.get(serial);
      return record && (!kind || record.entity.kind === kind)
        ? [perceiveEntity(this.world, record, true, this.now(), this.swings.get(serial))]
        : [];
    });
  }
  inventory(): readonly Readonly<Entity>[] {
    const items: Readonly<Entity>[] = [];
    const visited = new Set<number>();
    const visit = (parent: number) => {
      if (visited.has(parent)) return;
      visited.add(parent);
      for (const child of this.world.childrenOf(parent)) {
        if (child.layer === 29) continue; // Bank contents are not carried inventory.
        const record = this.records.get(child.serial);
        if (record && record.removedAt === undefined) {
          items.push(record.entity);
          visit(child.serial);
        }
      }
    };
    if (this.available) visit(this.world.serial ?? -1);
    return items;
  }
}
