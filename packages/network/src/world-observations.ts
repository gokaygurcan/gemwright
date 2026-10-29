import type { WorldView } from './world';

export type WorldField =
  | 'position'
  | 'map'
  | 'health'
  | 'mana'
  | 'stamina'
  | 'weight'
  | 'gold'
  | 'attributes'
  | 'poison'
  | 'range';
export type GameObservation =
  | { type: 'self-death' }
  | { type: 'entity-death'; serial: number; corpse: number }
  | { type: 'movement-rejected' }
  | { type: 'swing'; attacker: number; target: number };
export interface WorldChange {
  decoded: boolean;
  spatial: boolean;
  events: readonly GameObservation[];
  opcode: number | null;
  at: number;
  revision: number;
  entities: readonly number[];
  removed: readonly number[];
  skills: readonly number[];
  contexts: readonly number[];
  fields: readonly WorldField[];
  connected: boolean;
}

export class WorldObservations {
  readonly fieldAt = new Map<WorldField, number>();
  readonly entityAt = new Map<number, number>();
  readonly contextAt = new Map<number, number>();
  readonly skillAt = new Map<number, number>();
  private readonly listeners = new Set<{ read: (change: WorldChange) => void; failed: (error: unknown) => void }>();
  private batching = false;
  private changed = new Set<number>();
  private removed = new Set<number>();
  private skills = new Set<number>();
  private contexts = new Set<number>();
  constructor(private readonly world: WorldView) {}

  subscribe(read: (change: WorldChange) => void, failed: (error: unknown) => void): () => void {
    const listener = { read, failed };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  begin() {
    this.batching = true;
  }
  abort() {
    this.batching = false;
    this.changed.clear();
    this.removed.clear();
    this.skills.clear();
    this.contexts.clear();
  }
  entity(serial: number, removed = false) {
    (removed ? this.removed : this.changed).add(serial);
    if (removed) this.changed.delete(serial);
    else this.removed.delete(serial);
    if (!this.batching) this.publish(null);
  }
  context(serial: number) {
    this.contexts.add(serial);
  }
  skill(id: number) {
    this.skills.add(id);
  }
  packet(packet: Buffer) {
    const op = packet[0] ?? null;
    const events: GameObservation[] = [];
    if (op === 0x2c && packet[1] === 0) events.push({ type: 'self-death' });
    if (op === 0xaf)
      events.push({ type: 'entity-death', serial: packet.readUInt32BE(1), corpse: packet.readUInt32BE(5) });
    if (op === 0x21) events.push({ type: 'movement-rejected' });
    if (op === 0x2f) events.push({ type: 'swing', attacker: packet.readUInt32BE(2), target: packet.readUInt32BE(6) });
    this.publish(
      op,
      observedFields(this.world, packet),
      events,
      [0x1b, 0x20, 0x21, 0x22, 0x77, 0x78, 0xf3].includes(op ?? -1)
    );
  }
  publish(
    opcode: number | null,
    fields: readonly WorldField[] = [],
    events: readonly GameObservation[] = [],
    spatial = false
  ) {
    this.batching = false;
    const at = Date.now();
    const change: WorldChange = {
      decoded: opcode !== null,
      events,
      spatial,
      opcode,
      at,
      revision: this.world.revision,
      entities: [...this.changed],
      removed: [...this.removed],
      skills: [...this.skills],
      contexts: [...this.contexts],
      fields,
      connected: this.world.connected
    };
    if (opcode !== null) {
      for (const serial of change.entities) if (this.world.entities.has(serial)) this.entityAt.set(serial, at);
      for (const field of fields) this.fieldAt.set(field, at);
      for (const id of change.skills) this.skillAt.set(id, at);
      for (const id of change.contexts) this.contextAt.set(id, at);
    }
    for (const serial of change.removed) this.entityAt.delete(serial);
    this.changed.clear();
    this.removed.clear();
    this.skills.clear();
    this.contexts.clear();
    for (const listener of this.listeners) {
      try {
        listener.read(change);
      } catch (error) {
        try {
          listener.failed(error);
        } catch {
          /* A consumer cannot break packet reception. */
        }
      }
    }
  }
}

export function observedFields(world: WorldView, packet: Buffer): WorldField[] {
  const op = packet[0];
  const self = world.serial;
  if (op === 0x11 && packet.readUInt32BE(3) === self && world.status)
    return ['health', 'mana', 'stamina', 'weight', 'gold', 'attributes'];
  if ([0xa1, 0xa2, 0xa3, 0x2d].includes(op ?? -1) && packet.readUInt32BE(1) === self && world.status)
    return op === 0x2d
      ? ['health', 'mana', 'stamina']
      : op === 0xa1
        ? ['health']
        : op === 0xa2
          ? ['mana']
          : ['stamina'];
  if ([0x1b, 0x21, 0x22].includes(op ?? -1) || (op === 0x20 && packet.readUInt32BE(1) === self)) return ['position'];
  if (op === 0xbf && packet.readUInt16BE(3) === 8) return ['map'];
  if (op === 0x17 && packet.readUInt32BE(3) === self)
    for (let at = 9; at + 3 <= packet.length; at += 3) if (packet.readUInt16BE(at) === 1) return ['poison'];
  if (op === 0xc8) return ['range'];
  return [];
}
