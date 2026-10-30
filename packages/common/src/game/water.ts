// Water, for anything that has to find a shore: the land tiles that are open water and the static
// graphics that stand in for it (fishable water inside buildings and harbours).
export const waterLandTiles: ReadonlySet<number> = new Set([0xa8, 0xa9, 0xaa, 0xab, 0x136, 0x137]);
export const waterStaticGraphics: ReadonlySet<number> = new Set([0x1797, 0x1798, 0x1799, 0x179a, 0x179b, 0x179c]);
