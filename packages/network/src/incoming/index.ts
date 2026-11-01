import { accountPackets } from './account';
import type { Decoder } from './decoder';
import { entityPackets } from './entity';
import { extendedPackets } from './extended';
import { gumpPackets } from './gump';
import { itemPackets } from './item';
import { messagePackets } from './message';
import { mobilePackets } from './mobile';
import { movementPackets } from './movement';
import { playerPackets } from './player';
import { targetingPackets } from './targeting';
import { vendorPackets } from './vendor';

// Every server packet the world view understands, by packet identifier, from the per-domain modules.
export const decoders = new Map<number, Decoder>([
  ...accountPackets,
  ...entityPackets,
  ...extendedPackets,
  ...gumpPackets,
  ...itemPackets,
  ...messagePackets,
  ...mobilePackets,
  ...movementPackets,
  ...playerPackets,
  ...targetingPackets,
  ...vendorPackets
]);
