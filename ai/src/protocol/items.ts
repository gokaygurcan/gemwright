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
