import { Layer } from './layers';
import * as packets from './packets';
import type { PlayerSession } from './session';

export async function dropAtFeet(session: PlayerSession, send: (packet: Buffer) => void, serial: number) {
  const { world } = session;
  const item = world.entities.get(serial);
  const at = world.position;
  if (item?.kind !== 'item' || !at) throw new Error('Drop requires an observed item and position');
  const rejected = world.received.get(0x27) ?? 0;
  const refused = () => (world.received.get(0x27) ?? 0) > rejected;
  send(packets.liftItem(serial, item.amount ?? 1));
  await session.waitFor(() => !world.entities.has(serial) || refused(), 'item lift', 4000);
  if (refused()) throw new Error('Item lift rejected');
  send(packets.dropGround(serial, at.x, at.y, at.z));
  await session.waitFor(
    () => {
      const dropped = world.entities.get(serial);
      return (!!dropped?.position && dropped.parent === undefined) || refused();
    },
    'ground drop',
    4000
  );
  if (refused()) throw new Error('Ground drop rejected');
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
    4000
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
    item.graphic === 0x0eed &&
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
    4000
  );
  if ((session.world.received.get(0x27) ?? 0) > rejected) throw new Error('Server rejected item lift');
  send(packets.dropInto(serial, container));
  await session.waitFor(
    () =>
      session.world.entities.get(serial)?.parent === container ||
      destinationAmount() >= expectedAmount ||
      bankCredit() ||
      (session.world.received.get(0x27) ?? 0) > rejected,
    'item deposit confirmation',
    4000
  );
  if (session.world.entities.get(serial)?.parent !== container && destinationAmount() < expectedAmount && !bankCredit())
    throw new Error('Server rejected item deposit');
}
