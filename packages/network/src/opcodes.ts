// Opcodes the residents act on, named once. The wire's vocabulary belongs with the wire: a bare 0x74
// in an AI module was "the vendor buy list" written twenty-two times, and a mistyped digit was a
// silent wait that never ended.
export interface Opcodes {
  // Server → client.
  containerOpen: number;
  containerContents: number;
  vendorBuyList: number;
  gump: number;
  compressedGump: number;
}
export const Opcode: Opcodes = {
  containerOpen: 0x24, // DrawContainer: a container has been opened
  containerContents: 0x3c, // ContainerContentUpdate: an item inside an opened container
  vendorBuyList: 0x74, // VendorBuyList: the stock a vendor offers
  gump: 0xb0, // Gump
  compressedGump: 0xdd // CompressedGump
};

// Notoriety flags carried in the mobile packets (1 innocent … 7 invulnerable). Named once: the AI
// compares these numbers in thirty places.
export interface Notorieties {
  innocent: number;
  ally: number;
  gray: number;
  criminal: number;
  enemy: number;
  murderer: number;
  invulnerable: number;
}
export const Notoriety: Notorieties = {
  innocent: 1,
  ally: 2,
  gray: 3,
  criminal: 4,
  enemy: 5,
  murderer: 6,
  invulnerable: 7
};

// Notorieties a fighter may attack without becoming the aggressor against an innocent.
export const hostileNotoriety: readonly number[] = [
  Notoriety.gray,
  Notoriety.criminal,
  Notoriety.enemy,
  Notoriety.murderer
];
