import type { PlayerSession } from '@gemwright/network/session';

// Who is speaking: a person, or a server character? The shard serves a context menu per mobile and
// its entries give the kind away (ServUO ContextMenuEntry numbers, 3000000 added for the old ids):
//   - a vendor, trainer or guildmaster carries business entries — Buy 3006103, Sell 3006104,
//     Bulk Order Info 3006152, Bribe 1152294, Claim Rewards 1155593, Convert Mage Armor 1154114;
//   - a player carries the party entries BaseVendor never adds — Add 3000197, Remove 3000198.
// Nothing is decided from notoriety or from names: a guildmaster is as invulnerable as a vendor, a
// player may be called "Cher", and a game master checking on the town must still be talked to.
const BUSINESS = new Set([3006103, 3006104, 3006152, 1152294, 1155593, 1154114]);
const PARTY = new Set([3000197, 3000198]);
export type Identity = 'npc' | 'player' | 'unknown';

export function identityFrom(entries: { cliloc: number }[]): Identity {
  const numbers = new Set(entries.map((entry) => entry.cliloc));
  // Business entries decide first: a vendor that also offers party entries is still a vendor to
  // trade with, not a person to chat with.
  for (const number of numbers) if (BUSINESS.has(number)) return 'npc';
  for (const number of numbers) if (PARTY.has(number)) return 'player';
  return 'unknown';
}

// Menus are stable for hours; the answers are shared by every resident of the shard (one vendor is
// one vendor). A menu that never came teaches nothing and is asked again later.
const TTL = 6 * 3_600_000;
const known = new Map<string, { identity: Identity; at: number }>();
const inFlight = new Map<string, Promise<Identity>>();

export async function identify(session: PlayerSession, serial: number): Promise<Identity> {
  const key = `${session.world.map ?? -1}:${serial}`;
  const cached = known.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.identity;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const ask = session
    .context(serial)
    .then((entries) => {
      const identity = identityFrom(entries);
      known.set(key, { identity, at: Date.now() });
      return identity;
    })
    .catch(() => cached?.identity ?? ('unknown' as Identity))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, ask);
  return ask;
}

// Whether the answer is already on hand (no request needed): the listener bounds how many menus it
// asks for per pass with this, so a crowd of strangers cannot blow its action deadline.
export const identityKnown = (session: PlayerSession, serial: number) => {
  const cached = known.get(`${session.world.map ?? -1}:${serial}`);
  return !!cached && Date.now() - cached.at < TTL;
};
