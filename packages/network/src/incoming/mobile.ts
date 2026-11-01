import { applyHealthBar } from '../group-observations';
import { playerStatus, recordHealth } from '../status';
import { text } from '../world';
import type { Decoder } from './decoder';

export const mobilePackets: [number, Decoder][] = [
  /*
  Health Bar Status
  Server shows or clears a coloured health bar (green for poison, yellow for mortal wound).

  Size: 12 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Serial
  BYTE[2] Count (1)
  BYTE[2] Type (1 poison, 2 mortal)
  BYTE[1] Level (poison level + 1, 0 to clear)
  */
  [
    0x17,
    (world, packet) => {
      applyHealthBar(world, packet);
    }
  ],
  /*
  Swing
  Server shows an attacker swinging at a defender.

  Size: 10 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[1] Flag
  BYTE[4] Attacker serial
  BYTE[4] Defender serial
  */
  [
    0x2f,
    (world, packet) => {
      if (packet.length !== 10) throw new Error('Invalid swing observation length');
      const now = Date.now();
      for (const [serial, swing] of world.swings) if (now - swing.at > 8000) world.swings.delete(serial);
      if (world.swings.size >= 1000) world.swings.delete(world.swings.keys().next().value as number);
      world.swings.set(packet.readUInt32BE(2), { target: packet.readUInt32BE(6), at: now });
      world.observations.entity(packet.readUInt32BE(2));
    }
  ],
  /*
  Damage
  Server shows damage dealt to a mobile.

  Size: 7 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Amount
  */
  [
    0x0b,
    (world, packet) => {
      const serial = packet.readUInt32BE(1);
      if (world.damage.size > 1000) world.damage.clear();
      world.damage.set(serial, { at: Date.now(), amount: packet.readUInt16BE(5) });
    }
  ],
  /*
  Death Animation
  Server shows a mobile dying and names the corpse it left.

  Size: 13 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Killed serial
  BYTE[4] Corpse serial (0 for none)
  BYTE[4] Unknown (0)
  */
  [
    0xaf,
    (world, packet) => {
      const killed = packet.readUInt32BE(1);
      world.observations.entity(killed);
      if (world.deaths.size > 500) world.deaths.clear();
      world.deaths.set(killed, { corpse: packet.readUInt32BE(5), position: world.entities.get(killed)?.position });
    }
  ],
  /*
  Mobile Mana
  Server updates a mobile's mana.

  Size: 9 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Maximum mana
  BYTE[2] Mana
  */
  [
    0xa2,
    (world, packet) => {
      if (packet.readUInt32BE(1) === world.serial && world.status) {
        world.status.maxMana = packet.readUInt16BE(5);
        world.status.mana = packet.readUInt16BE(7);
      }
    }
  ],
  /*
  Mobile Stamina
  Server updates a mobile's stamina.

  Size: 9 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Maximum stamina
  BYTE[2] Stamina
  */
  [
    0xa3,
    (world, packet) => {
      if (packet.readUInt32BE(1) === world.serial && world.status) {
        world.status.maxStamina = packet.readUInt16BE(5);
        world.status.stamina = packet.readUInt16BE(7);
      }
    }
  ],
  /*
  Mobile Attributes
  Server updates hit points, mana and stamina at once.

  Size: 17 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Maximum hits
  BYTE[2] Hits
  BYTE[2] Maximum mana
  BYTE[2] Mana
  BYTE[2] Maximum stamina
  BYTE[2] Stamina
  */
  [
    0x2d,
    (world, packet) => {
      if (packet.readUInt32BE(1) === world.serial && world.status) {
        recordHealth(world, packet.readUInt16BE(7), packet.readUInt16BE(5));
        world.status.maxHits = packet.readUInt16BE(5);
        world.status.hits = packet.readUInt16BE(7);
        world.status.maxMana = packet.readUInt16BE(9);
        world.status.mana = packet.readUInt16BE(11);
        world.status.maxStamina = packet.readUInt16BE(13);
        world.status.stamina = packet.readUInt16BE(15);
      }
    }
  ],
  /*
  Mobile Hits
  Server updates a mobile's hit points.

  Size: 9 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Maximum hits
  BYTE[2] Hits
  */
  [
    0xa1,
    (world, packet) => {
      {
        const entity = world.entities.get(packet.readUInt32BE(1));
        if (entity)
          world.put({
            ...entity,
            maxHits: packet.readUInt16BE(5),
            hits: packet.readUInt16BE(7),
            healthAt: Date.now()
          });
      }
      if (packet.readUInt32BE(1) === world.serial && world.status) {
        recordHealth(world, packet.readUInt16BE(7), packet.readUInt16BE(5));
        world.status.maxHits = packet.readUInt16BE(5);
        world.status.hits = packet.readUInt16BE(7);
      }
    }
  ],
  /*
  Mobile Moving
  Server moves (or turns) a mobile already in view.

  Size: 17 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[4] Serial
  BYTE[2] Body
  BYTE[2] X
  BYTE[2] Y
  BYTE[1] Z
  BYTE[1] Direction
  BYTE[2] Hue
  BYTE[1] Flags
  BYTE[1] Notoriety
  */
  [
    0x77,
    (world, packet) => {
      world.put({
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
    }
  ],
  /*
  Mobile Incoming
  Server brings a mobile into view, with what it wears.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Serial
  BYTE[2] Body
  BYTE[2] X
  BYTE[2] Y
  BYTE[1] Z
  BYTE[1] Direction
  BYTE[2] Hue
  BYTE[1] Flags
  BYTE[1] Notoriety
  Per worn item:
    BYTE[4] Item serial (0 ends the list)
    BYTE[2] Item graphic
    BYTE[1] Layer
    BYTE[2] Hue
  */
  [
    0x78,
    (world, packet) => {
      const serial = packet.readUInt32BE(3);
      world.put({
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
        world.put({
          serial: equipped,
          kind: 'item',
          graphic: packet.readUInt16BE(offset + 4),
          layer: packet.readUInt8(offset + 6),
          parent: serial
        });
        offset += 9;
      }
    }
  ],
  /*
  Mobile Status
  Server sends a mobile's name and health, and for the character itself its full status
  (stats, gold, weight, resistances, followers) when the type is 5 or more.

  Size: Variable

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Serial
  BYTE[30] Name
  BYTE[2] Hits
  BYTE[2] Maximum hits
  BYTE[1] Can rename
  BYTE[1] Type (0 health only; 5 and up adds the full status, see status.ts)
  */
  [
    0x11,
    (world, packet) => {
      const serial = packet.readUInt32BE(3);
      const entity = world.entities.get(serial);
      if (entity)
        world.put({
          ...entity,
          name: text(packet, 7, 30),
          hits: packet.readUInt16BE(37),
          maxHits: packet.readUInt16BE(39),
          healthAt: Date.now()
        });
      if (serial === world.serial && packet.length >= 69 && packet.readUInt8(42) >= 5) {
        recordHealth(world, packet.readUInt16BE(37), packet.readUInt16BE(39));
        world.status = playerStatus(packet);
      }
    }
  ],
  /*
  Mobile Name
  Server answers a name request.

  Size: 37 bytes

  Packet Build
  BYTE[1] Packet identifier
  BYTE[2] Length
  BYTE[4] Serial
  BYTE[30] Name
  */
  [
    0x98,
    (world, packet) => {
      const serial = packet.readUInt32BE(3);
      const entity = world.entities.get(serial);
      if (entity) world.put({ ...entity, name: text(packet, 7, 30) });
    }
  ]
];
