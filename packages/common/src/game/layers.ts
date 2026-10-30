// Where an item sits on a mobile (ServUO Server/Item.cs Layer; the 0x2E equip packet's layer byte).
export const LAYERS = {
  oneHanded: 0x01, // weapon or shield in one hand
  twoHanded: 0x02, // two-handed weapon, or shield
  shoes: 0x03,
  pants: 0x04,
  shirt: 0x05,
  helm: 0x06,
  gloves: 0x07,
  ring: 0x08,
  talisman: 0x09,
  neck: 0x0a,
  hair: 0x0b,
  waist: 0x0c, // half apron, sash
  innerTorso: 0x0d, // chest armour
  bracelet: 0x0e,
  face: 0x0f,
  facialHair: 0x10,
  middleTorso: 0x11, // surcoat, tunic
  earrings: 0x12,
  arms: 0x13,
  cloak: 0x14,
  backpack: 0x15,
  outerTorso: 0x16, // robe
  outerLegs: 0x17, // skirt, kilt
  innerLegs: 0x18, // leg armour
  mount: 0x19, // the ridden animal's mount item
  shopBuy: 0x1a, // a vendor's stock
  shopResale: 0x1b, // what a vendor resells
  shopSell: 0x1c, // what a vendor buys
  bank: 0x1d, // the bank box
  secureTrade: 0x1f // a secure trade's container
} as const;
