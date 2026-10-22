import { Blocked } from '../blocked';
import * as packets from './packets';
import type { PlayerSession } from './session';

export async function purchaseItem(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  vendor: number,
  serial: number,
  backpack: number,
  amount: number,
  budget: number
): Promise<void> {
  const item = session.world.entities.get(serial);
  const offer = [...session.world.buyOffers.values()].flat().find((entry) => entry.serial === serial);
  const stock = item?.parent === undefined ? undefined : session.world.entities.get(item.parent);
  if (
    !item ||
    !offer ||
    stock?.parent !== vendor ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 32767 ||
    amount > (item.amount ?? 1) ||
    offer.price <= 0 ||
    offer.price * amount > budget
  )
    throw new Error('Purchase requires current stock within the spending limit');
  const count = () =>
    [...session.world.entities.values()]
      .filter((entry) => entry.parent === backpack && entry.graphic === item.graphic)
      .reduce((sum, entry) => sum + (entry.amount ?? 1), 0);
  const before = count();
  const seen = new Set(session.world.journal);
  // 500191/500192: the vendor found neither carried nor banked gold to cover the cost.
  const refused = () =>
    session.world.journal.some(
      (entry) => !seen.has(entry) && entry.serial === vendor && [500191, 500192].includes(entry.cliloc ?? 0)
    );
  const owned = new Set(
    [...session.world.entities.values()].filter((entry) => entry.parent === backpack).map((entry) => entry.serial)
  );
  // Delivered items may use a different art variant than the stock display; a new backpack item
  // together with the vendor's own receipt confirms the sale.
  const receipt = () =>
    session.world.journal.some(
      (entry) => !seen.has(entry) && entry.serial === vendor && /^The total of thy purchase is/.test(entry.text ?? '')
    );
  const delivered = () =>
    [...session.world.entities.values()].some((entry) => entry.parent === backpack && !owned.has(entry.serial));
  send(packets.buyItem(vendor, serial, amount));
  await session.waitFor(
    () => refused() || count() >= before + amount || (receipt() && delivered()),
    'purchased items in backpack',
    5000
  );
  if (refused()) throw new Blocked('insufficient-funds', 'Vendor refused: carried and banked gold cannot cover it');
}

export function requestAnimalPurchase(
  session: PlayerSession,
  send: (packet: Buffer) => void,
  vendor: number,
  serial: number,
  budget: number
): void {
  const stock = session.world.entities.get(serial);
  const pack = stock?.parent === undefined ? undefined : session.world.entities.get(stock.parent);
  const offer = [...session.world.buyOffers.values()].flat().find((entry) => entry.serial === serial);
  const status = session.world.status;
  if (
    !stock ||
    !offer ||
    pack?.parent !== vendor ||
    ![0xc8, 0xe2, 0xe4, 0xcc].includes(stock.graphic) ||
    !(stock.amount && stock.amount > 0) ||
    !Number.isFinite(budget) ||
    offer.price <= 0 ||
    offer.price > budget ||
    !status ||
    status.followers === undefined ||
    status.maxFollowers === undefined ||
    status.followers >= status.maxFollowers
  )
    throw new Error('Animal purchase requires current horse stock, funds and a free follower slot');
  send(packets.buyItem(vendor, serial, 1));
}
