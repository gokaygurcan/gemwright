import { variable } from './packets';
import type { WorldView } from './world';

// The secure trade window (0x6F, ServUO SecureTrade). It opens when one player drops an item on
// another within 2 tiles; each side has a container the other sees, offers by dropping items (gold
// coins included) into its own, and the swap happens only after both accept. Any change to either
// container clears both acceptances. The server reports a completed swap only by closing the window,
// so a deal is confirmed by what arrives in the backpack, never by the close alone. Account-gold
// offers (action 3) reach only clients from 7.0.45.65, so residents pay in coins they can both see.
export interface TradeWindow {
  partner: number;
  name: string;
  mine: number;
  theirs: number;
  accepted: { me: boolean; them: boolean };
  closed: boolean;
}

export function applyTrade(world: WorldView, packet: Buffer): void {
  const action = packet.readUInt8(3);
  const container = packet.readUInt32BE(4);
  if (action === 0) {
    world.trade = {
      partner: container,
      mine: packet.readUInt32BE(8),
      theirs: packet.readUInt32BE(12),
      name: packet.length >= 47 && packet.readUInt8(16) ? (packet.toString('latin1', 17, 47).split('\0')[0] ?? '') : '',
      accepted: { me: false, them: false },
      closed: false
    };
    return;
  }
  const trade = world.trade;
  if (!trade || container !== trade.mine) return;
  if (action === 1) trade.closed = true;
  else if (action === 2) trade.accepted = { me: packet.readUInt32BE(8) !== 0, them: packet.readUInt32BE(12) !== 0 };
}

const tradeAction = (action: number, container: number, value?: number) => {
  const body = Buffer.alloc(value === undefined ? 5 : 9);
  body[0] = action;
  body.writeUInt32BE(container, 1);
  if (value !== undefined) body.writeUInt32BE(value, 5);
  return variable(0x6f, body);
};
export const tradeCancel = (container: number) => tradeAction(1, container);
export const tradeAccept = (container: number, accepted: boolean) => tradeAction(2, container, accepted ? 1 : 0);
