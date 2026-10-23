import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { ConnectionConfig } from '../connection';
import { timed } from '../stall-probe';
import { characterList } from './characters';
import { purchaseItem, requestAnimalPurchase } from './commerce';
import { gumpCommands } from './gumps';
import { dropAtFeet, giveToMobile, moveItem } from './items';
import * as packets from './packets';
import {
  refreshCharacterStatus,
  requestContext,
  resynchronize,
  SessionTiming,
  waitForUpdate
} from './session-observation';
import { requestSkills } from './skill-query';
import { tradeAccept, tradeCancel } from './trade';
import { Transport } from './transport';
import { type Position, text, WorldView } from './world';

export type { CharacterRequest, Credentials, SessionPhase } from './session-types';

import type { CharacterRequest, Credentials, SessionPhase } from './session-types';

export class PlayerSession {
  readonly movementCounts = { running: 0, walking: 0, turns: 0, rejected: 0 };
  readonly world = new WorldView();
  readonly timing = new SessionTiming();
  get signal() {
    return this.timing.controller.signal;
  }
  phase: SessionPhase = 'offline';
  private readonly events = new EventEmitter();
  private transport: Transport | null = null;
  private failure: Error | null = null;
  private auth: number | null = null;
  private servers: { index: number; name: string }[] | null = null;
  private roster: ReturnType<typeof characterList> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private lastPacketAt = Date.now();
  private movement: {
    sequence: number;
    direction: number;
    before: Position;
    expectedZ?: number;
    running: boolean;
    result?: boolean;
  } | null = null;

  constructor(
    readonly config: ConnectionConfig,
    private readonly assertOwnership: () => void = () => {}
  ) {}

  get failureReason(): string | null {
    return this.failure?.message ?? null;
  }

  get reconnectable(): boolean {
    return (
      this.failure !== null &&
      /^(Shard TCP connection failed(?: \((?:[A-Z0-9_]+|unknown)\))?|Shard connection (closed|timed out)|Movement outcome is uncertain; reconnect before moving again|Connection ended with a truncated protocol packet)$/.test(
        this.failure.message
      )
    );
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.timing.controller.abort();
    this.phase = 'failed';
    this.transport?.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.events.emit('update');
  }

  private send(packet: Buffer): void {
    this.assertOwnership();
    if (this.failure) throw this.failure;
    if (!this.transport) throw new Error('No shard connection');
    this.timing.sent(packet[0] ?? -1, packet[0] === 0x02 ? packet[2] : undefined);
    this.transport.write(packet);
  }

  waitFor(predicate: () => boolean, label: string, timeoutMs = this.config.timeoutMs): Promise<void> {
    return waitForUpdate(this.events, () => this, predicate, label, timeoutMs);
  }

  private receive(packet: Buffer): void {
    this.lastPacketAt = Date.now();
    const opcode = packet.readUInt8(0);
    this.timing.received(opcode, opcode === 0x21 || opcode === 0x22 ? packet[1] : undefined);
    if (opcode === 0x82) throw new Error(`Shard rejected login (reason ${packet.readUInt8(1)})`);
    if (opcode === 0x53 && this.phase !== 'ready')
      throw new Error(`Shard rejected character entry (reason ${packet.readUInt8(1)})`);
    if (opcode === 0xa8) {
      const count = packet.readUInt16BE(4);
      if (count > 100 || packet.length !== 6 + count * 40) throw new Error('Invalid server list');
      this.servers = Array.from({ length: count }, (_, i) => ({
        index: packet.readUInt16BE(6 + i * 40),
        name: text(packet, 8 + i * 40, 32)
      }));
    } else if (opcode === 0x8c) {
      // Railway's advertised internal route is not trusted; keep the configured one.
      this.auth = packet.readUInt32BE(7);
      this.phase = 'relay';
    } else if (opcode === 0xa9) {
      this.roster = characterList(packet);
      this.phase = 'characters';
    } else if (opcode === 0xbd) {
      this.send(packets.variable(0xbd, Buffer.from(`${packets.CLIENT_VERSION}\0`, 'ascii')));
    } else if (opcode === 0x22 || opcode === 0x21) {
      const sequence = packet.readUInt8(1);
      const pending = this.movement;
      if (opcode === 0x21) {
        this.movementCounts.rejected++;
        this.world.position = {
          x: packet.readUInt16BE(2),
          y: packet.readUInt16BE(4),
          direction: packet.readUInt8(6) & 7,
          z: packet.readInt8(7)
        };
        this.sequence = 0;
        if (pending) pending.result = false;
      } else if (pending && pending.sequence === sequence) {
        const delta = packets.movementDeltas[pending.direction];
        if (!delta) throw new Error('Invalid pending movement');
        const moved = pending.before.direction === pending.direction;
        if (moved) this.movementCounts[pending.running ? 'running' : 'walking']++;
        else this.movementCounts.turns++;
        this.world.position = {
          ...pending.before,
          direction: pending.direction,
          x: pending.before.x + (moved ? delta[0] : 0),
          y: pending.before.y + (moved ? delta[1] : 0),
          z: moved ? (pending.expectedZ ?? pending.before.z) : pending.before.z
        };
        this.sequence = sequence === 255 ? 1 : sequence + 1;
        pending.result = true;
      }
    } else if (opcode === 0x20 && packet.readUInt32BE(1) === this.world.serial) {
      // ServUO zeroes NetState.Sequence with every full self update.
      this.sequence = 0;
    }
    timed('apply', () => this.world.apply(packet));
    if ((opcode === 0x21 || opcode === 0x22) && this.world.serial !== null && this.world.position) {
      const self = this.world.entities.get(this.world.serial);
      if (self) self.position = { ...this.world.position };
    }
    if (this.world.ready && this.world.serial !== null) this.phase = 'ready';
    timed('wake', () => this.events.emit('update'));
  }

  async connect(credentials: Credentials, request: CharacterRequest): Promise<void> {
    if (this.phase !== 'offline') throw new Error('Use a fresh session when reconnecting');
    this.phase = 'login';
    try {
      this.transport = new Transport(
        false,
        (packet) => this.receive(packet),
        (error) => this.fail(error)
      );
      await this.transport.open(this.config);
      this.send(
        Buffer.concat([
          packets.loginSeed(randomInt(1, 0xffffffff)),
          packets.accountLogin(credentials.username, credentials.password)
        ])
      );
      await this.waitFor(() => this.servers !== null, 'server list');
      if (!this.servers?.some((server) => server.index === this.config.serverIndex))
        throw new Error('Requested server index was not offered');
      this.send(packets.selectServer(this.config.serverIndex));
      await this.waitFor(() => this.auth !== null, 'game relay');
      this.transport.close();
      this.transport = new Transport(
        true,
        (packet) => this.receive(packet),
        (error) => this.fail(error)
      );
      await this.transport.open(this.config);
      if (this.auth === null) throw new Error('Missing game authentication token');
      this.send(packets.gameLogin(this.auth, credentials.username, credentials.password));
      await this.waitFor(() => this.roster !== null, 'character list');
      const roster = this.roster;
      if (!roster || request.slot < 0 || request.slot >= roster.characters.length)
        throw new Error('Invalid character slot');
      const existing = roster.characters[request.slot];
      this.phase = 'entering';
      if (existing) {
        if (request.create && existing !== request.create.name)
          throw new Error('Unbound account contains a different character than the requested resident');
        this.send(packets.playCharacter(existing, request.slot));
      } else if (request.create) {
        const city = roster.cities.find((city) => city.name.toLowerCase() === request.create?.city.toLowerCase());
        if (!city) throw new Error('Requested starting city was not offered by the shard');
        this.send(packets.createCharacter({ ...request.create, city: city.index, slot: request.slot }));
      } else throw new Error('Character slot is empty; creation must be explicitly enabled');
      await this.waitFor(() => this.phase === 'ready', 'world entry');
      this.heartbeat = setInterval(() => {
        try {
          if (Date.now() - this.lastPacketAt > this.config.timeoutMs) {
            this.fail(new Error('Shard connection timed out'));
            return;
          }
          this.send(Buffer.from([0x73, 0]));
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error('Session heartbeat failed'));
        }
      }, 10000);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Session connection failed'));
      throw this.failure;
    }
  }

  private requireReady(): void {
    this.assertOwnership();
    if (this.phase !== 'ready') throw new Error('Character is not ready');
  }

  async walk(direction: number, expectedZ?: number, running = false): Promise<boolean> {
    this.requireReady();
    if (this.movement) throw new Error('A movement request is already pending');
    if (!this.world.position) throw new Error('Character position is unknown');
    const pending = {
      sequence: this.sequence,
      direction,
      before: { ...this.world.position },
      expectedZ,
      running,
      result: undefined as boolean | undefined
    };
    this.movement = pending;
    try {
      this.send(packets.walk(direction, pending.sequence, running));
      await this.waitFor(() => pending.result !== undefined, 'movement acknowledgement', 5000);
      return pending.result === true;
    } catch (error) {
      if (this.phase !== 'ready') throw error;
      this.movement = null;
      // Resync instead of reconnecting; the step counts as refused.
      if (await resynchronize(this, (packet) => this.send(packet), pending.sequence)) return false;
      this.fail(new Error('Movement outcome is uncertain; reconnect before moving again'));
      throw error;
    } finally {
      this.movement = null;
    }
  }

  say(message: string): void {
    this.requireReady();
    this.send(packets.speech(message));
  }

  replyGump(serial: number, id: number, button: number, switches: number[]): void {
    this.requireReady();
    const gump = this.world.gumps.get(`${serial}:${id}`);
    if (!gump) throw new Error('Gump is not currently open');
    const commands = gumpCommands(gump.layout);
    if (
      !commands.some((command) => command[0] === 'button' && command[5] === '1' && Number(command[7]) === button) ||
      switches.some((value) => !commands.some((command) => command[0] === 'radio' && Number(command[6]) === value))
    )
      throw new Error('Gump reply must use offered controls');
    this.send(packets.gumpReply(serial, id, button, switches));
    this.world.gumps.delete(`${serial}:${id}`);
  }

  async refreshStatus(): Promise<void> {
    this.requireReady();
    await refreshCharacterStatus(this, (packet) => this.send(packet));
  }

  async refreshSkills(): Promise<void> {
    this.requireReady();
    await requestSkills(
      this.world,
      (packet) => this.send(packet),
      (predicate, label, timeout) => this.waitFor(predicate, label, timeout)
    );
  }

  async context(serial: number): Promise<{ index: number; cliloc: number; flags: number }[]> {
    this.requireReady();
    return requestContext(this, serial, (packet) => this.send(packet));
  }

  selectContext(serial: number, index: number): void {
    this.requireReady();
    const entry = this.world.contextMenus.get(serial)?.find((item) => item.index === index);
    if (!entry || entry.flags & 1) throw new Error('Context action is absent or disabled');
    this.send(packets.contextMenu(serial, index));
    this.world.contextMenus.delete(serial);
  }

  async moveItem(serial: number, container: number, amount?: number): Promise<void> {
    this.requireReady();
    await moveItem(this, (packet) => this.send(packet), serial, container, amount);
  }

  async purchaseItem(vendor: number, serial: number, backpack: number, amount: number, budget: number): Promise<void> {
    this.requireReady();
    await purchaseItem(this, (packet) => this.send(packet), vendor, serial, backpack, amount, budget);
  }

  async purchaseAnimal(vendor: number, serial: number, budget: number): Promise<void> {
    this.requireReady();
    requestAnimalPurchase(this, (packet) => this.send(packet), vendor, serial, budget);
  }

  async inspect(serial: number): Promise<void> {
    this.requireReady();
    if (!this.world.entities.has(serial)) throw new Error('Inspection target is not observed');
    this.send(packets.queryStatus(serial));
    await this.waitFor(() => !!this.world.entities.get(serial)?.name, 'observed character name', 2500);
  }

  async inspectProperties(serial: number): Promise<void> {
    this.requireReady();
    const entity = this.world.entities.get(serial);
    if (!entity) throw new Error('Property target is not observed');
    if (entity.properties) return;
    this.send(packets.properties(serial));
    await this.waitFor(() => this.world.entities.get(serial)?.properties !== undefined, 'object properties', 2500);
  }

  setWarMode(enabled: boolean): void {
    this.requireReady();
    this.send(packets.warMode(enabled));
  }

  async attack(serial: number): Promise<void> {
    this.requireReady();
    if (this.world.entities.get(serial)?.kind !== 'mobile') throw new Error('Attack target is not observed');
    this.send(packets.attack(serial));
    await this.waitFor(() => this.world.combatant === serial, 'server combat target', 1800);
  }

  async giveToMobile(serial: number, mobile: number, amount: number): Promise<void> {
    this.requireReady();
    await giveToMobile(this, (packet) => this.send(packet), serial, mobile, amount);
  }

  // Drops an item at the character's feet (an unwanted death robe).
  async dropAtFeet(serial: number): Promise<void> {
    this.requireReady();
    await dropAtFeet(this, (packet) => this.send(packet), serial);
  }

  async equipItem(serial: number, layer: number): Promise<void> {
    this.requireReady();
    const item = this.world.entities.get(serial);
    if (item?.kind !== 'item' || this.world.serial === null) throw new Error('Equipment is not observed');
    const rejected = this.world.received.get(0x27) ?? 0;
    this.send(packets.liftItem(serial, 1));
    await this.waitFor(
      () => !this.world.entities.has(serial) || (this.world.received.get(0x27) ?? 0) > rejected,
      'equipment lift',
      4000
    );
    if ((this.world.received.get(0x27) ?? 0) > rejected) throw new Error('Equipment lift rejected');
    this.send(packets.equip(serial, layer, this.world.serial));
    await this.waitFor(
      () =>
        this.world.entities.get(serial)?.parent === this.world.serial ||
        (this.world.received.get(0x27) ?? 0) > rejected,
      'equipment confirmation',
      4000
    );
    if (this.world.entities.get(serial)?.layer !== layer) throw new Error('Equipment rejected');
  }

  // Accepts (or withdraws acceptance of) the open trade, or cancels it; trade.ts has the rules.
  acceptTrade(accepted = true): void {
    this.requireReady();
    const trade = this.world.trade;
    if (!trade || trade.closed) throw new Error('No open trade window');
    this.send(tradeAccept(trade.mine, accepted));
  }

  cancelTrade(): void {
    this.requireReady();
    const trade = this.world.trade;
    if (trade && !trade.closed) this.send(tradeCancel(trade.mine));
  }

  async sell(vendor: number, items: { serial: number; amount: number }[]): Promise<void> {
    this.requireReady();
    const offers = this.world.sellOffers.get(vendor);
    for (const item of items) {
      const offer = offers?.find((entry) => entry.serial === item.serial);
      if (
        !offer ||
        offer.price <= 0 ||
        item.amount < 1 ||
        item.amount > offer.amount ||
        item.amount > 32767 ||
        !Number.isInteger(item.amount)
      )
        throw new Error('Sale requires a current vendor offer');
    }
    const before = this.world.received.get(0x3b) ?? 0;
    this.send(packets.sellItems(vendor, items));
    await this.waitFor(() => (this.world.received.get(0x3b) ?? 0) > before, 'vendor sale reply', 5000);
    if (items.some((item) => this.world.entities.has(item.serial)))
      throw new Error('Sale did not remove the offered items');
  }

  use(serial: number): void {
    this.requireReady();
    if (!this.world.entities.has(serial)) throw new Error('Item is outside current observations');
    if (this.world.target) throw new Error('Finish the current targeting first');
    this.send(packets.useItem(serial));
  }

  // Party add (cursor), accept, decline, leave, or say to all.
  party(command: 'add' | 'accept' | 'decline' | 'leave' | 'say', leader = 0, text = ''): void {
    this.requireReady();
    this.send(packets.party(command, leader, text));
  }

  // Lock 0 up, 1 down, 2 locked.
  setLock(kind: 'stat' | 'skill', index: number, lock: number): void {
    this.requireReady();
    this.send(kind === 'stat' ? packets.statLock(index, lock) : packets.skillLock(index, lock));
  }

  useSkill(id: number, spell = false): void {
    this.requireReady();
    if (this.world.target) throw new Error('Finish the current targeting first');
    this.send(packets.useSkill(id, spell));
  }

  target(location: packets.TargetLocation | null): void {
    this.requireReady();
    const cursor = this.world.target;
    if (!cursor) throw new Error('No active targeting cursor');
    if (location?.serial && location.serial !== this.world.serial && !this.world.entities.has(location.serial))
      throw new Error('Target is outside current observations');
    if (location && !location.serial && location.graphic === 0 && !cursor.ground)
      throw new Error('This cursor does not permit ground targeting');
    this.send(packets.targetResponse(cursor, location));
    this.world.target = null;
  }

  close(): void {
    this.timing.controller.abort();
    this.transport?.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.phase = 'offline';
    this.world.ready = false;
    this.events.emit('update');
  }
}
