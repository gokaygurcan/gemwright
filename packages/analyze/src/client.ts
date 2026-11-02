import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GumpArt, ItemArt } from '@gemwright/common/assets/art';
import { FACET_SIZES, Facet } from '@gemwright/common/assets/facet';
import { Hues } from '@gemwright/common/assets/hues';
import { color16, encodePng, type Image } from '@gemwright/common/assets/png';
import { clientSkills } from '@gemwright/common/assets/skill-groups';
import { Tiledata } from '@gemwright/common/assets/tiledata';

// The game client's files, drawn for the pages: gumps, item art and radar squares as PNGs (kept
// once drawn), item tile data, and the client's skill names and groups.
export class ClientFiles {
  readonly tiles: Tiledata;
  readonly skills: ReturnType<typeof clientSkills>;
  private readonly gumps: GumpArt;
  private readonly art: ItemArt;
  private readonly hues: Hues;
  private readonly facets = new Map<number, Facet>();
  private readonly grids = new Map<number, Uint16Array>();
  private readonly pngs = new Map<string, Buffer | null>();
  private readonly sizes = new Map<string, { width: number; height: number } | null>();

  constructor(readonly directory: string) {
    this.tiles = new Tiledata(directory);
    this.skills = clientSkills(directory);
    this.gumps = new GumpArt(directory);
    this.art = new ItemArt(directory);
    this.hues = new Hues(directory);
  }

  private cached(key: string, draw: () => Image | undefined) {
    if (!this.pngs.has(key)) {
      const image = draw();
      this.sizes.set(key, image ? { width: image.width, height: image.height } : null);
      this.pngs.set(key, image ? encodePng(image) : null);
    }
    return this.pngs.get(key) ?? undefined;
  }

  gump(id: number, hue = 0, partial = false) {
    return this.cached(`g${id}:${hue}:${partial}`, () => this.gumps.get(id, { hues: this.hues, hue, partial }));
  }

  item(graphic: number, hue = 0) {
    const partial = this.tiles.item(graphic).partialHue;
    return this.cached(`a${graphic}:${hue}`, () => this.art.get(graphic, { hues: this.hues, hue, partial }));
  }

  // A gump's or item's size, drawing it once if needed.
  gumpSize(id: number) {
    this.gump(id);
    return this.sizes.get(`g${id}:0:false`) ?? undefined;
  }
  itemSize(graphic: number) {
    this.item(graphic);
    return this.sizes.get(`a${graphic}:0`) ?? undefined;
  }

  private facet(map: number) {
    let facet = this.facets.get(map);
    if (!facet) {
      facet = new Facet(this.directory, map);
      this.facets.set(map, facet);
    }
    return facet;
  }

  radar(map: number, x: number, y: number, size: number) {
    return encodePng(this.facet(map).radar(x, y, size));
  }

  // One square of the world map: 256 pixels across, covering 256 << level tiles from tile
  // (tx, ty) of that grid, one pixel per 1 << level tiles. The facet's colours are read once.
  mapTile(map: number, level: number, tx: number, ty: number) {
    const size = FACET_SIZES[map];
    if (!size || level < 0 || level > MAP_LEVELS - 1) return undefined;
    return this.cached(`m${map}:${level}:${tx}:${ty}`, () => {
      const [width, height] = size;
      let grid = this.grids.get(map);
      if (!grid) {
        grid = this.facet(map).colorGrid();
        this.grids.set(map, grid);
      }
      const step = 1 << level;
      const rgba = new Uint8Array(256 * 256 * 4);
      for (let py = 0; py < 256; py++)
        for (let px = 0; px < 256; px++) {
          const x = (tx * 256 + px) * step;
          const y = (ty * 256 + py) * step;
          if (x >= width || y >= height) continue;
          const [r, g, b] = color16(grid[y * width + x] ?? 0);
          rgba.set([r, g, b, 255], (py * 256 + px) * 4);
        }
      return { width: 256, height: 256, rgba };
    });
  }
}

// The world map's scales: level n draws one pixel per 2^n tiles.
export const MAP_LEVELS = 5;

// The client files: --files, else the repository's files/ folder when it has them.
export function findClientFiles(given?: string) {
  const repository = fileURLToPath(new URL('../../../files', import.meta.url));
  const directory = given ?? repository;
  return existsSync(join(directory, 'gumpartLegacyMUL.uop')) ? new ClientFiles(directory) : undefined;
}
