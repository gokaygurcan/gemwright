import { setTimeout as sleep } from 'node:timers/promises';

import { gold } from '@gemwright/common/game/items';

import { CommandRejected } from './errors';
import { Layer } from './layers';
import * as packets from './packets';
import { ShardMessage } from './replies';
import type { PlayerSession } from './session';
import { WaitTimeout } from './wait-options';

// Lifts an item; true when the shard refused it. ServUO Mobile.Lift refuses a lift inside the
// action delay (500 ms after the last action: opening a bank box, the previous lift) with
// ShardMessage.mustWait and a lift rejection. That refusal means "not yet": the lift is tried again
// once the delay has passed, a few times, before it counts as refused.
async function lift(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  serial: number,
  amount: number,
  lifted: () => boolean,
  label: string
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const rejected = session.world.received.get(0x27) ?? 0;
    const heard = new Set(session.world.journal);
    send(packets.liftItem(serial, amount));
    await session.waitFor(() => lifted() || (session.world.received.get(0x27) ?? 0) > rejected, label, 4000, {
      interruptible: false
    });
    if ((session.world.received.get(0x27) ?? 0) <= rejected) return false;
    const notYet = session.world.journal.some((entry) => !heard.has(entry) && entry.cliloc === ShardMessage.mustWait);
    if (!notYet || attempt >= 3) return true;
    await sleep(700);
  }
}

// Lifts an item and drops it on one ground tile; false when the shard bounced it back. ServUO
// (Item.DropToWorld) takes x and y from the drop, finds the height itself (FindDropPoint) and
// refuses a tile more than 2 away, out of sight, without a surface, or with a mobile standing on it.
export async function dropOnTile(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  serial: number,
  at: { x: number; y: number; z: number }
) {
  const { world } = session;
  const item = world.entities.get(serial);
  if (item?.kind !== 'item') throw new Error('Drop requires an observed item');
  if (await lift(session, send, serial, item.amount ?? 1, () => !world.entities.has(serial), 'item lift'))
    throw new Error('Item lift rejected');
  const rejected = world.received.get(0x27) ?? 0;
  const refused = () => (world.received.get(0x27) ?? 0) > rejected;
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
  // A drop the shard accepted is no longer observed at the feet: the item left the container it was
  // lifted from, and refusals and returns arrive as packets of their own, so absence is acceptance.
  return !refused() && world.entities.get(serial)?.parent === undefined;
}

// Onto the ground beside it, as a player drags an item off the paperdoll onto a free tile: never
// its own tile (ServUO PlayerMobile.OnDroppedItemToWorld refuses a tile any mobile stands on, the
// dropper too), each neighbouring tile no mobile is seen on tried in turn until one takes it.
export async function dropAtFeet(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  serial: number,
  offset?: { x: number; y: number }
) {
  const { world } = session;
  const here = world.position;
  if (world.entities.get(serial)?.kind !== 'item' || !here)
    throw new Error('Drop requires an observed item and position');
  const occupied = (x: number, y: number) =>
    (x === here.x && y === here.y) ||
    [...world.entities.values()].some((e) => e.kind === 'mobile' && e.position?.x === x && e.position.y === y);
  const tiles = offset
    ? [offset]
    : [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1]
      ].map(([x = 0, y = 0]) => ({ x, y }));
  for (const tile of tiles) {
    const x = here.x + tile.x;
    const y = here.y + tile.y;
    if (!offset && occupied(x, y)) continue;
    if (await dropOnTile(session, send, serial, { x, y, z: here.z })) return;
  }
  throw new CommandRejected('item-drop-rejected', 'Ground drop refused; item returned to its owner');
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
  const moved = () => world.entities.get(serial)?.amount !== item.amount || !world.entities.has(serial);
  if (await lift(session, send, serial, amount, moved, 'item lift')) throw new Error('Item lift rejected');
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
  if (await lift(session, send, serial, quantity, () => !session.world.entities.has(serial), 'item lift'))
    throw new Error('Server rejected item lift');
  const rejected = session.world.received.get(0x27) ?? 0;
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
  if (await lift(session, send, serial, 1, () => !session.world.entities.has(serial), 'equipment lift'))
    throw new Error('Equipment lift rejected');
  const rejected = session.world.received.get(0x27) ?? 0;
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
