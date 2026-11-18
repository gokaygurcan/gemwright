import { EntityMap } from './entity-map';
import type { HouseDesign } from './house-design';
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

// A client sees 18 tiles around itself and nothing beyond, whatever the server sends or leaves out
// (ServUO never removes what leaves range by walking).
export const SIGHT = 18;

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
  private here: Position | null = null;
  get position(): Position | null {
    return this.here;
  }
  set position(value: Position | null) {
    const moved = !!value && (value.x !== this.here?.x || value.y !== this.here?.y);
    this.here = value;
    if (!moved) return;
    this.shown.clear();
    for (const entity of [...this.entities.values()]) this.cull(entity);
  }
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
  // Each mobile's latest animation, as every client in view is sent it: `type` is the SA animation
  // type (0 attack, 11 spell) of 0xE2, null for an old-style 0x6E action.
  readonly animations = new Map<number, { type: number | null; action: number; at: number }>();
  readonly damage = new Map<number, { at: number; amount: number }>();
  readonly deaths = new Map<number, { corpse: number; position?: Position }>();
  lastContainerContents: number[] = [];
  // Containers whose contents were shown since its last step: a step closes a bank box (ServUO
  // Mobile.Move), and what lies in one closed can no longer be looked at.
  readonly shown = new Set<number>();
  readonly houseDesigns = new Map<number, HouseDesign>();
  readonly houseRevisions = new Map<number, number>();
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
    this.houseDesigns.delete(serial);
    this.houseRevisions.delete(serial);
  }

  // Gone from view with everything it holds.
  forget(serial: number): void {
    const pending = [serial];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      pending.push(...this.entities.childSerials(next));
      this.remove(next);
    }
  }

  private cull(entity: Entity): void {
    const here = this.here;
    const at = entity.position;
    if (!here || !at || entity.serial === this.serial || entity.parent !== undefined) return;
    if (Math.max(Math.abs(at.x - here.x), Math.abs(at.y - here.y)) > SIGHT) this.forget(entity.serial);
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
    else this.cull(next);
  }

  // How many of its oldest lines the journal has let go.
  private dropped = 0;

  // How much it has heard all told: a mark that stays true after the journal drops its oldest lines.
  get heard() {
    return this.dropped + this.journal.length;
  }

  addJournal(entry: Omit<JournalEntry, 'at'>): void {
    this.journal.push({ ...entry, at: new Date().toISOString() });
    if (this.journal.length > 200) {
      this.journal.shift();
      this.dropped++;
    }
  }

  // What it heard after the mark `heard` was taken (those still kept).
  journalSince(mark: number): JournalEntry[] {
    return this.journal.slice(Math.max(0, mark - this.dropped));
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
