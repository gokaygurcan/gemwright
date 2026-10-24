// Equipment layers as the client protocol numbers them (an item's `layer` on its wearer).
export const Layer = {
  /** One-handed weapon. */
  OneHanded: 1,
  /** Two-handed weapon or shield. */
  TwoHanded: 2,
  Shoes: 3,
  Pants: 4,
  Shirt: 5,
  /** Helmets, hats and masks. */
  Helm: 6,
  Gloves: 7,
  Ring: 8,
  Talisman: 9,
  /** Gorgets and necklaces. */
  Neck: 10,
  Hair: 11,
  /** Half aprons. */
  Waist: 12,
  /** Torso, inner layer. */
  InnerTorso: 13,
  Bracelet: 14,
  Face: 15,
  /** Beards and moustaches. */
  FacialHair: 16,
  /** Torso, middle layer. */
  MiddleTorso: 17,
  Earrings: 18,
  /** Arms and sleeves. */
  Arms: 19,
  Cloak: 20,
  Backpack: 21,
  /** Torso, outer layer. */
  OuterTorso: 22,
  /** Legs, outer layer. */
  OuterLegs: 23,
  /** Legs, inner layer. */
  InnerLegs: 24,
  /** The mount item. */
  Mount: 25,
  /** A vendor's stock. */
  ShopBuy: 26,
  /** A vendor's resale stock. */
  ShopResale: 27,
  /** What a vendor buys. */
  ShopSell: 28,
  /** The bank box. */
  Bank: 29
} as const;
