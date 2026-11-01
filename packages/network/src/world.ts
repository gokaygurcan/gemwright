import { EntityMap } from './entity-map';
import { decoders } from './incoming';
import type { TargetCursor } from './packets';
import type { PlayerStatus } from './status';
import type { TradeWindow } from './trade';
import { WorldObservations } from './world-observations';
import { worldSnapshot } from './world-snapshot';
import type { Entity, HealthChange, JournalEntry, Position } from './world-types';

export { EntityMap } from './entity-map';
export type { Entity, JournalEntry, Position } from './world-types';

export function text(buffer: Buffer, offset: number, length: number): string {
  if (offset + length > buffer.length) throw new Error('Truncated text field');
  return (
    buffer
      .subarray(offset, offset + length)
      .toString('latin1')
      .split('\0', 1)[0] ?? ''
  );
}

export function unicode(buffer: Buffer, offset: number, little = false): string {
  const bytes = Buffer.from(buffer.subarray(offset));
  if (bytes.length % 2) throw new Error('Odd-length Unicode field');
  if (!little) bytes.swap16();
  return bytes.toString('utf16le').split('\0', 1)[0] ?? '';
}

export class WorldView {
  connected = true;
  viewRange = 18;
  readonly observations = new WorldObservations(this);
  disconnect() {
    this.connected = false;
    this.ready = false;
    this.observations.publish(null);
  }
  serial: number | null = null;
  position: Position | null = null;
  map: number | null = null;
  ready = false;
  combatant: number | null = null;
  // The open (or last closed) secure trade window (trade.ts).
  trade: TradeWindow | null = null;
  deathSite: Position | null = null;
  warMode = false;
  poisonLevel: number | null = null;
  target: TargetCursor | null = null;
  // The open text prompt (0xC2): a guild war or alliance name asked for.
  prompt: { serial: number; id: number } | null = null;
  status: PlayerStatus | null = null;
  readonly contextMenus = new Map<number, { index: number; cliloc: number; flags: number }[]>();
  readonly buyOffers = new Map<number, { serial: number; price: number; description: string }[]>();
  readonly sellOffers = new Map<
    number,
    { serial: number; graphic: number; hue: number; amount: number; price: number; name: string }[]
  >();
  statLocks: number[] | null = null;
  readonly skills = new Map<number, { value: number; base: number; cap: number; lock: number }>();
  readonly partyMembers = new Set<number>();
  // The last party invitation received (PartyInvitation, 0xBF 0x06 0x07): its leader and when.
  partyInvite: { leader: number; at: number } | null = null;
  readonly healthChanges: HealthChange[] = [];
  readonly swings = new Map<number, { target: number; at: number }>();
  readonly damage = new Map<number, { at: number; amount: number }>();
  readonly deaths = new Map<number, { corpse: number; position?: Position }>();
  lastContainerContents: number[] = [];
  readonly entities = new EntityMap((serial, removed) => this.observations.entity(serial, removed));
  readonly journal: JournalEntry[] = [];
  readonly gumps = new Map<string, { serial: number; id: number; packed: boolean; layout: string }>();
  readonly received = new Map<number, number>();
  revision = 0;

  childrenOf(parent: number): Entity[] {
    return this.entities.childrenOf(parent);
  }

  remove(serial: number): void {
    this.entities.delete(serial);
  }

  put(entity: Entity): void {
    if (!this.entities.has(entity.serial) && this.entities.size >= 20000)
      throw new Error('Observed entity limit exceeded');
    const previous = this.entities.get(entity.serial);
    const next = { ...previous, ...entity };
    if (entity.parent !== undefined) delete next.position;
    else if (entity.kind === 'item' && entity.position) {
      delete next.parent;
      delete next.layer;
    }
    this.entities.set(entity.serial, next);
    if (entity.serial === this.serial && entity.position) this.position = entity.position;
  }

  addJournal(entry: Omit<JournalEntry, 'at'>): void {
    this.journal.push({ ...entry, at: new Date().toISOString() });
    if (this.journal.length > 200) this.journal.shift();
  }

  containerEntry(packet: Buffer, offset: number): void {
    if (offset + 20 > packet.length) throw new Error('Truncated container entry');
    this.put({
      serial: packet.readUInt32BE(offset),
      kind: 'item',
      graphic: packet.readUInt16BE(offset + 4) + packet.readInt8(offset + 6),
      amount: packet.readUInt16BE(offset + 7),
      containerX: packet.readUInt16BE(offset + 9),
      parent: packet.readUInt32BE(offset + 14),
      hue: packet.readUInt16BE(offset + 18)
    });
  }

  apply(packet: Buffer): void {
    this.observations.begin();
    try {
      this.decode(packet);
    } catch (error) {
      this.observations.abort();
      this.disconnect();
      throw error;
    }
    this.observations.packet(packet);
  }

  private decode(packet: Buffer): void {
    const opcode = packet.readUInt8(0);
    this.received.set(opcode, (this.received.get(opcode) ?? 0) + 1);
    this.revision++;
    decoders.get(opcode)?.(this, packet, opcode);
  }

  snapshot() {
    return worldSnapshot(this);
  }
}
