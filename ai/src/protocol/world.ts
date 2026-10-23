import type { HealthChange } from '../combat-risk';
import { EntityMap } from './entity-map';
import { gumpLayout } from './gumps';
import type { TargetCursor } from './packets';
import { speechEntry } from './speech';
import { type PlayerStatus, playerStatus } from './status';
import { applyTrade, type TradeWindow } from './trade';

export { EntityMap } from './entity-map';

export interface Position {
  x: number;
  y: number;
  z: number;
  direction: number;
}
export interface Entity {
  serial: number;
  kind: 'mobile' | 'item';
  graphic: number;
  hue?: number;
  name?: string;
  position?: Position;
  parent?: number;
  layer?: number;
  amount?: number;
  containerX?: number;
  flags?: number;
  notoriety?: number;
  hits?: number;
  maxHits?: number;
  properties?: { cliloc: number; arguments: string }[];
}
export interface JournalEntry {
  at: string;
  serial: number;
  name: string;
  text?: string;
  type?: number; // speech: 0 regular, 2 emote, 6 label
  party?: boolean; // party chat, heard by members wherever they are
  cliloc?: number;
  arguments?: string;
}

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
  status: PlayerStatus | null = null;
  readonly contextMenus = new Map<number, { index: number; cliloc: number; flags: number }[]>();
  readonly buyOffers = new Map<number, { serial: number; price: number; description: string }[]>();
  readonly sellOffers = new Map<
    number,
    { serial: number; graphic: number; hue: number; amount: number; price: number; name: string }[]
  >();
  statLocks: number[] | null = null;
  readonly skills = new Map<number, { value: number; base: number; cap: number; lock: number }>();
  readonly healthChanges: HealthChange[] = [];
  readonly damage = new Map<number, { at: number; amount: number }>();
  readonly deaths = new Map<number, { corpse: number; position?: Position }>();
  private lastContainerContents: number[] = [];
  readonly entities = new EntityMap();
  readonly journal: JournalEntry[] = [];
  readonly gumps = new Map<string, { serial: number; id: number; packed: boolean; layout: string }>();
  readonly received = new Map<number, number>();
  revision = 0;

  private recordHealth(hits: number, maxHits: number): void {
    if (!this.status || this.status.hits === hits) return;
    const adjustedPrevious = this.status.hits - Math.max(0, this.status.maxHits - maxHits);
    this.healthChanges.push({
      at: Date.now(),
      hits,
      maxHits,
      damage: Math.max(0, adjustedPrevious - hits),
      healed: Math.max(0, hits - this.status.hits)
    });
    if (this.healthChanges.length > 128) this.healthChanges.shift();
  }

  childrenOf(parent: number): Entity[] {
    return this.entities.childrenOf(parent);
  }

  private remove(serial: number): void {
    this.entities.delete(serial);
  }

  private put(entity: Entity): void {
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

  private addJournal(entry: Omit<JournalEntry, 'at'>): void {
    this.journal.push({ ...entry, at: new Date().toISOString() });
    if (this.journal.length > 200) this.journal.shift();
  }

  private containerEntry(packet: Buffer, offset: number): void {
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
    const opcode = packet.readUInt8(0);
    this.received.set(opcode, (this.received.get(opcode) ?? 0) + 1);
    this.revision++;
    switch (opcode) {
      case 0x17: {
        if (packet.length < 9) throw new Error('Truncated health-bar status');
        const count = packet.readUInt16BE(7);
        if (packet.length !== 9 + count * 3) throw new Error('Invalid health-bar status length');
        if (packet.readUInt32BE(3) === this.serial) {
          for (let offset = 9; offset < packet.length; offset += 3)
            if (packet.readUInt16BE(offset) === 1) this.poisonLevel = packet.readUInt8(offset + 2);
        }
        break;
      }
      case 0x3a: {
        const format = packet.readUInt8(3);
        if (format !== 2 && format !== 0xdf) throw new Error('Unsupported skill observation format');
        if (format === 0xdf && packet.length !== 13) throw new Error('Invalid skill delta');
        let offset = 4;
        while (offset < packet.length) {
          const wireId = packet.readUInt16BE(offset);
          offset += 2;
          if (format === 2 && wireId === 0) {
            if (offset !== packet.length) throw new Error('Invalid skill terminator');
            break;
          }
          const id = format === 2 ? wireId - 1 : wireId;
          if (id < 0 || id > 57 || offset + 7 > packet.length) throw new Error('Invalid observed skill');
          this.skills.set(id, {
            value: packet.readUInt16BE(offset) / 10,
            base: packet.readUInt16BE(offset + 2) / 10,
            lock: packet.readUInt8(offset + 4),
            cap: packet.readUInt16BE(offset + 5) / 10
          });
          offset += 7;
        }
        break;
      }
      case 0x0b: {
        const serial = packet.readUInt32BE(1);
        if (this.damage.size > 1000) this.damage.clear();
        this.damage.set(serial, { at: Date.now(), amount: packet.readUInt16BE(5) });
        break;
      }
      case 0x2c:
        if (packet.readUInt8(1) === 0 && this.position) this.deathSite = { ...this.position };
        break;
      case 0xaa:
        this.combatant = packet.readUInt32BE(1) || null;
        break;
      case 0x72:
        this.warMode = packet.readUInt8(1) !== 0;
        break;
      case 0xaf: {
        const killed = packet.readUInt32BE(1);
        if (this.deaths.size > 500) this.deaths.clear();
        this.deaths.set(killed, { corpse: packet.readUInt32BE(5), position: this.entities.get(killed)?.position });
        break;
      }
      case 0x9e: {
        const vendor = packet.readUInt32BE(3),
          count = packet.readUInt16BE(7);
        let offset = 9;
        const offers = [];
        for (let i = 0; i < count; i++) {
          const length = packet.readUInt16BE(offset + 12);
          offers.push({
            serial: packet.readUInt32BE(offset),
            graphic: packet.readUInt16BE(offset + 4),
            hue: packet.readUInt16BE(offset + 6),
            amount: packet.readUInt16BE(offset + 8),
            price: packet.readUInt16BE(offset + 10),
            name: text(packet, offset + 14, length)
          });
          offset += 14 + length;
        }
        if (offset !== packet.length) throw new Error('Invalid vendor sale list');
        this.sellOffers.set(vendor, offers);
        break;
      }
      case 0xd6: {
        const serial = packet.readUInt32BE(5),
          properties = [];
        let offset = 15;
        while (offset + 4 <= packet.length) {
          const cliloc = packet.readUInt32BE(offset);
          offset += 4;
          if (!cliloc) break;
          const length = packet.readUInt16BE(offset);
          offset += 2;
          if (length % 2 || offset + length > packet.length) throw new Error('Invalid object property text');
          properties.push({ cliloc, arguments: packet.subarray(offset, offset + length).toString('utf16le') });
          offset += length;
        }
        const entity = this.entities.get(serial);
        if (entity) this.put({ ...entity, properties });
        break;
      }
      case 0xa3:
        if (packet.readUInt32BE(1) === this.serial && this.status) {
          this.status.maxStamina = packet.readUInt16BE(5);
          this.status.stamina = packet.readUInt16BE(7);
        }
        break;
      case 0x2d:
        if (packet.readUInt32BE(1) === this.serial && this.status) {
          this.recordHealth(packet.readUInt16BE(7), packet.readUInt16BE(5));
          this.status.maxHits = packet.readUInt16BE(5);
          this.status.hits = packet.readUInt16BE(7);
          this.status.maxStamina = packet.readUInt16BE(13);
          this.status.stamina = packet.readUInt16BE(15);
        }
        break;
      case 0xa1:
        {
          const entity = this.entities.get(packet.readUInt32BE(1));
          if (entity) this.put({ ...entity, maxHits: packet.readUInt16BE(5), hits: packet.readUInt16BE(7) });
        }
        if (packet.readUInt32BE(1) === this.serial && this.status) {
          this.recordHealth(packet.readUInt16BE(7), packet.readUInt16BE(5));
          this.status.maxHits = packet.readUInt16BE(5);
          this.status.hits = packet.readUInt16BE(7);
        }
        break;
      case 0x74: {
        const container = packet.readUInt32BE(3);
        const count = packet.readUInt8(7);
        const vendor = this.entities.get(container)?.parent;
        const items = this.lastContainerContents
          .flatMap((serial) => {
            const item = this.entities.get(serial);
            const pack = item?.parent === undefined ? undefined : this.entities.get(item.parent);
            return item && (item.parent === container || (vendor !== undefined && pack?.parent === vendor))
              ? [item]
              : [];
          })
          .sort((a, b) => (a.containerX ?? 0) - (b.containerX ?? 0));
        if (items.length !== count) throw new Error('Vendor price list does not match observed stock');
        const offers = [];
        let offset = 8;
        for (const item of items) {
          const price = packet.readUInt32BE(offset);
          const length = packet.readUInt8(offset + 4);
          offers.push({ serial: item.serial, price, description: text(packet, offset + 5, length) });
          offset += 5 + length;
        }
        if (offset !== packet.length) throw new Error('Invalid vendor price list');
        this.buyOffers.set(container, offers);
        break;
      }
      case 0x1b:
        this.serial = packet.readUInt32BE(1);
        this.position = {
          x: packet.readUInt16BE(11),
          y: packet.readUInt16BE(13),
          z: packet.readInt16BE(15),
          direction: packet.readUInt8(17) & 7
        };
        break;
      case 0x55:
        this.ready = true;
        break;
      case 0x20:
        this.put({
          serial: packet.readUInt32BE(1),
          kind: 'mobile',
          graphic: packet.readUInt16BE(5),
          flags: packet.readUInt8(10),
          position: {
            x: packet.readUInt16BE(11),
            y: packet.readUInt16BE(13),
            z: packet.readInt8(18),
            direction: packet.readUInt8(17) & 7
          }
        });
        break;
      case 0x77:
        this.put({
          serial: packet.readUInt32BE(1),
          kind: 'mobile',
          graphic: packet.readUInt16BE(5),
          flags: packet.readUInt8(15),
          notoriety: packet.readUInt8(16),
          position: {
            x: packet.readUInt16BE(7),
            y: packet.readUInt16BE(9),
            z: packet.readInt8(11),
            direction: packet.readUInt8(12) & 7
          }
        });
        break;
      case 0x78: {
        const serial = packet.readUInt32BE(3);
        this.put({
          serial,
          kind: 'mobile',
          graphic: packet.readUInt16BE(7),
          flags: packet.readUInt8(17),
          notoriety: packet.readUInt8(18),
          position: {
            x: packet.readUInt16BE(9),
            y: packet.readUInt16BE(11),
            z: packet.readInt8(13),
            direction: packet.readUInt8(14) & 7
          }
        });
        let offset = 19;
        while (true) {
          const equipped = packet.readUInt32BE(offset);
          if (equipped === 0) break;
          if (offset + 9 > packet.length) throw new Error('Truncated mobile equipment');
          this.put({
            serial: equipped,
            kind: 'item',
            graphic: packet.readUInt16BE(offset + 4),
            layer: packet.readUInt8(offset + 6),
            parent: serial
          });
          offset += 9;
        }
        break;
      }
      case 0xf3:
        this.put({
          serial: packet.readUInt32BE(4),
          kind: 'item',
          graphic: packet.readUInt16BE(8),
          amount: packet.readUInt16BE(11),
          position: { x: packet.readUInt16BE(15), y: packet.readUInt16BE(17), z: packet.readInt8(19), direction: 0 },
          flags: packet.readUInt8(23),
          hue: packet.readUInt16BE(21)
        });
        break;
      case 0x1d: {
        const pending = [packet.readUInt32BE(1)];
        for (let serial = pending.pop(); serial !== undefined; serial = pending.pop()) {
          pending.push(...this.entities.childSerials(serial));
          this.remove(serial);
        }
        break;
      }
      case 0x2e:
        this.put({
          serial: packet.readUInt32BE(1),
          kind: 'item',
          graphic: packet.readUInt16BE(5),
          layer: packet.readUInt8(8),
          parent: packet.readUInt32BE(9)
        });
        break;
      case 0x25:
        this.containerEntry(packet, 1);
        break;
      case 0x3c: {
        const count = packet.readUInt16BE(3);
        if (packet.length !== 5 + count * 20) throw new Error('Invalid grid-container content length');
        const parents = new Set<number>();
        const present = new Set<number>();
        for (let i = 0; i < count; i++) {
          present.add(packet.readUInt32BE(5 + i * 20));
          parents.add(packet.readUInt32BE(19 + i * 20));
        }
        this.lastContainerContents = [...present];
        for (const parent of parents)
          for (const serial of [...this.entities.childSerials(parent)]) if (!present.has(serial)) this.remove(serial);
        for (let i = 0; i < count; i++) this.containerEntry(packet, 5 + i * 20);
        break;
      }
      case 0x11: {
        const serial = packet.readUInt32BE(3);
        const entity = this.entities.get(serial);
        if (entity)
          this.put({
            ...entity,
            name: text(packet, 7, 30),
            hits: packet.readUInt16BE(37),
            maxHits: packet.readUInt16BE(39)
          });
        if (serial === this.serial && packet.length >= 69 && packet.readUInt8(42) >= 5) {
          this.recordHealth(packet.readUInt16BE(37), packet.readUInt16BE(39));
          this.status = playerStatus(packet);
        }
        break;
      }
      case 0x98: {
        const serial = packet.readUInt32BE(3);
        const entity = this.entities.get(serial);
        if (entity) this.put({ ...entity, name: text(packet, 7, 30) });
        break;
      }
      case 0x1c:
      case 0xae:
      case 0xc1:
      case 0xcc:
        this.addJournal(speechEntry(opcode, packet));
        break;
      case 0x6f:
        applyTrade(this, packet);
        break;
      case 0x6c:
        this.target =
          packet.readUInt8(6) === 3
            ? null
            : { id: packet.readUInt32BE(2), ground: packet.readUInt8(1) === 1, flags: packet.readUInt8(6) };
        break;
      case 0xbf:
        // Party chat (PartyTextMessage): 3 private, 4 to all; sender serial, Unicode text.
        if (packet.readUInt16BE(3) === 0x06 && [3, 4].includes(packet.readUInt8(5))) {
          const serial = packet.readUInt32BE(6);
          const name = this.entities.get(serial)?.name ?? '';
          this.addJournal({ serial, name, text: unicode(packet, 10), party: true });
        }
        if (packet.readUInt16BE(3) === 0x14) {
          if (packet.readUInt16BE(5) !== 2) throw new Error('Unsupported context menu format');
          const serial = packet.readUInt32BE(7);
          const count = packet.readUInt8(11);
          if (packet.length !== 12 + count * 8) throw new Error('Invalid context menu length');
          const entries = [];
          for (let i = 0; i < count; i++)
            entries.push({
              cliloc: packet.readUInt32BE(12 + i * 8),
              index: packet.readUInt16BE(16 + i * 8),
              flags: packet.readUInt16BE(18 + i * 8)
            });
          if (this.contextMenus.size > 1000) this.contextMenus.clear();
          this.contextMenus.set(serial, entries);
        }
        if (packet.readUInt16BE(3) === 8) this.map = packet.readUInt8(5);
        // StatLockInfo: two bits per stat (str, dex, int); 0 up, 1 down, 2 locked.
        if (packet.readUInt16BE(3) === 0x19 && packet.length >= 12 && packet.readUInt32BE(6) === this.serial) {
          const bits = packet.readUInt8(11);
          this.statLocks = [(bits >> 4) & 3, (bits >> 2) & 3, bits & 3];
        }
        if (packet.readUInt16BE(3) === 4) {
          const id = packet.readUInt32BE(5);
          for (const [key, gump] of this.gumps) if (gump.id === id) this.gumps.delete(key);
        }
        break;
      case 0xb0:
      case 0xdd: {
        if (this.gumps.size >= 100) throw new Error('Open gump limit exceeded');
        const serial = packet.readUInt32BE(3);
        const id = packet.readUInt32BE(7);
        this.gumps.set(`${serial}:${id}`, { serial, id, packed: opcode === 0xdd, layout: gumpLayout(packet) });
        break;
      }
    }
  }

  snapshot() {
    return {
      ready: this.ready,
      serial: this.serial,
      position: this.position,
      map: this.map,
      status: this.status,
      combatant: this.combatant,
      deathSite: this.deathSite,
      healthChanges: this.healthChanges,
      skills: Object.fromEntries(this.skills),
      warMode: this.warMode,
      poisonLevel: this.poisonLevel,
      entities: [...this.entities.values()],
      journal: [...this.journal],
      target: this.target,
      gumps: [...this.gumps.values()],
      revision: this.revision,
      received: Object.fromEntries(
        [...this.received].map(([id, count]) => [`0x${id.toString(16).padStart(2, '0')}`, count])
      )
    };
  }
}
