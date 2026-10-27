import type { ProfessionContext } from './profession';
import type { Entity } from './protocol/world';
import { offered, postOffer, shopShare, withdrawOffer } from './resident-offers';

// A tamer's spare animals sold to residents (resident-offers.ts) instead of released: a mount
// beyond the one it rides, and pack animals. The stable master charges about 550 for a horse
// and 600 for a pack animal (SBAnimalTrainer); a resident pays 60% of that. Two are for sale at a
// time, so follower slots stay free for taming; one unsold after 45 minutes is released.
const PACK = new Set([0x123, 0x124]);
const PRICES = { mount: 550, pack: 600 };
const FOR_MS = 45 * 60_000;
const forSale = new WeakMap<object, Map<number, { kind: 'mount' | 'pack'; since: number }>>();

type Sale = { kind: 'mount' | 'pack'; since: number };
const listed = (ctx: ProfessionContext) => {
  const list = forSale.get(ctx.session) ?? new Map<number, Sale>();
  forSale.set(ctx.session, list);
  return list;
};

// True when the new pet is put up for sale (else the caller releases it).
export function offerPet(ctx: ProfessionContext, pet: Entity, mount: boolean): boolean {
  const kind = PACK.has(pet.graphic) ? 'pack' : mount ? 'mount' : undefined;
  const list = listed(ctx);
  if (!kind || list.size >= 2) return false;
  list.set(pet.serial, { kind, since: Date.now() });
  keepOffers(ctx);
  ctx.log(`Offering the ${pet.name ?? kind} to residents for ${shopShare(PRICES[kind])} gold`);
  return true;
}

// Each turn: offers follow the tamer; sold ones drop off; unsold ones are released in the end.
export async function keepOffers(ctx: ProfessionContext, release?: (pet: Entity) => Promise<void>) {
  const list = listed(ctx);
  for (const [serial, sale] of list) {
    const pet = ctx.session.world.entities.get(serial);
    const sold = !pet || (!offered(serial) && Date.now() - sale.since > 1000);
    if (sold || Date.now() - sale.since > FOR_MS) {
      list.delete(serial);
      withdrawOffer(serial);
      if (pet && !sold) await release?.(pet);
      continue;
    }
    postOffer({
      seller: ctx.serial,
      kind: sale.kind,
      item: serial,
      label: pet.name?.replace(/^an? /i, '') ?? sale.kind,
      price: shopShare(PRICES[sale.kind]),
      at: ctx.position()
    });
  }
}
