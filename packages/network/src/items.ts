import { gold } from '@gemwright/common/items';

import { CommandRejected } from './errors';
import { Layer } from './layers';
import * as packets from './packets';
import type { PlayerSession } from './session';
import { WaitTimeout } from './wait-options';

// At its feet, or on a tile next to it (a tile holds only so much: Item.FindDropPoint).
export async function dropAtFeet(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  serial: number,
  offset = { x: 0, y: 0 }
) {
  const { world } = session;
  const item = world.entities.get(serial);
  const at = world.position && { ...world.position, x: world.position.x + offset.x, y: world.position.y + offset.y };
  if (item?.kind !== 'item' || !at) throw new Error('Drop requires an observed item and position');
  const rejected = world.received.get(0x27) ?? 0;
  const refused = () => (world.received.get(0x27) ?? 0) > rejected;
  send(packets.liftItem(serial, item.amount ?? 1));
  await session.waitFor(() => !world.entities.has(serial) || refused(), 'item lift', 4000, { interruptible: false });
  if (refused()) throw new Error('Item lift rejected');
  send(packets.dropGround(serial, at.x, at.y, at.z));
  try {
    await session.waitFor(
      () => {
        const dropped = world.entities.get(serial);
        return (!!dropped?.position && dropped.parent === undefined) || dropped?.parent !== undefined || refused();
      },
      'ground drop',
      4000,
      { interruptible: false, deadline: 'timeout' }
    );
  } catch (error) {
    if (!(error instanceof WaitTimeout)) throw error;
  }
  const landed = world.entities.get(serial);
  if (refused() || landed?.parent !== undefined)
    throw new CommandRejected('item-drop-rejected', 'Ground drop refused; item returned to its owner');
  // A drop the shard accepted is no longer observed at the feet: the item left the container it was
  // lifted from, and refusals and returns arrive as packets of their own, so absence is acceptance.
}

// Hands part of a stack to a mobile (paying a trainer), as a player drags gold onto an NPC.
// The recipient's reaction is the caller's confirmation; a bounced drop reports refusal.
export async function giveToMobile(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  serial: number,
  mobile: number,
  amount: number
) {
  const { world } = session;
  const item = world.entities.get(serial);
  if (item?.kind !== 'item' || world.entities.get(mobile)?.kind !== 'mobile')
    throw new Error('Giving requires an observed item and recipient');
  if (!Number.isInteger(amount) || amount < 1 || amount > (item.amount ?? 1)) throw new Error('Invalid give amount');
  const rejected = world.received.get(0x27) ?? 0;
  send(packets.liftItem(serial, amount));
  await session.waitFor(
    () =>
      (world.received.get(0x27) ?? 0) > rejected ||
      world.entities.get(serial)?.amount !== item.amount ||
      !world.entities.has(serial),
    'item lift',
    4000,
    { interruptible: false }
  );
  if ((world.received.get(0x27) ?? 0) > rejected) throw new Error('Item lift rejected');
  send(packets.dropInto(serial, mobile));
}

// Lifts an item and drops it into a container, confirmed by the item arriving (or merging into a
// stack) there; a bank deposit of gold is confirmed by the banker's credit message instead.
export async function moveItem(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  serial: number,
  container: number,
  amount?: number
): Promise<void> {
  const item = session.world.entities.get(serial);
  if (item?.kind !== 'item' || !session.world.entities.has(container))
    throw new Error('Move requires observed item and destination');
  const quantity = amount ?? item.amount ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > (item.amount ?? 1))
    throw new Error('Invalid lift quantity');
  const rejected = session.world.received.get(0x27) ?? 0;
  const destinationAmount = () =>
    [...session.world.entities.values()]
      .filter((other) => other.parent === container && other.graphic === item.graphic && other.hue === item.hue)
      .reduce((sum, other) => sum + (other.amount ?? 1), 0);
  const expectedAmount = destinationAmount() + quantity;
  const previousFeedback = new Set(session.world.journal);
  const destination = session.world.entities.get(container);
  const bankCredit = () =>
    item.graphic === gold &&
    destination?.parent === session.world.serial &&
    destination.layer === Layer.Bank &&
    session.world.journal.some(
      (entry) =>
        !previousFeedback.has(entry) &&
        entry.cliloc === 1042763 &&
        Number(entry.arguments?.replaceAll(',', '')) === quantity
    );
  send(packets.liftItem(serial, quantity));
  await session.waitFor(
    () => !session.world.entities.has(serial) || (session.world.received.get(0x27) ?? 0) > rejected,
    'item lift',
    4000,
    { interruptible: false }
  );
  if ((session.world.received.get(0x27) ?? 0) > rejected) throw new Error('Server rejected item lift');
  send(packets.dropInto(serial, container));
  await session.waitFor(
    () =>
      session.world.entities.get(serial)?.parent === container ||
      destinationAmount() >= expectedAmount ||
      bankCredit() ||
      session.world.entities.get(serial)?.parent !== undefined ||
      (session.world.received.get(0x27) ?? 0) > rejected,
    'item deposit confirmation',
    4000,
    { interruptible: false }
  );
  if (session.world.entities.get(serial)?.parent !== container && destinationAmount() < expectedAmount && !bankCredit())
    throw new CommandRejected('item-transfer-rejected', 'Item transfer refused; item returned to another location');
}

export async function equipItem(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  serial: number,
  layer: number
): Promise<void> {
  const item = session.world.entities.get(serial);
  if (item?.kind !== 'item' || session.world.serial === null) throw new Error('Equipment is not observed');
  const rejected = session.world.received.get(0x27) ?? 0;
  send(packets.liftItem(serial, 1));
  await session.waitFor(
    () => !session.world.entities.has(serial) || (session.world.received.get(0x27) ?? 0) > rejected,
    'equipment lift',
    4000,
    { interruptible: false }
  );
  if ((session.world.received.get(0x27) ?? 0) > rejected) throw new Error('Equipment lift rejected');
  send(packets.equip(serial, layer, session.world.serial));
  try {
    await session.waitFor(
      () =>
        session.world.entities.get(serial)?.parent !== undefined || (session.world.received.get(0x27) ?? 0) > rejected,
      'equipment confirmation',
      4000,
      { interruptible: false, deadline: 'timeout' }
    );
  } catch (error) {
    if (!(error instanceof WaitTimeout)) throw error;
  }
  const equipped = session.world.entities.get(serial);
  // The shard wears the item on its own layer (Item.Layer from its tiledata) and ignores the layer
  // asked for, so a piece that lands on us worn has succeeded whatever layer it landed on.
  if (equipped?.parent === session.world.serial) return;
  throw new CommandRejected(
    'equipment-rejected',
    equipped
      ? `Equipment refused (0x${item.graphic.toString(16)} on layer ${layer}); item returned to another location`
      : `Equipment outcome was not observed (0x${item.graphic.toString(16)} on layer ${layer})`
  );
}
