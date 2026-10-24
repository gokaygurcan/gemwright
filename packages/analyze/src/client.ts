import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GumpArt, ItemArt } from '@gemwright/common/art';
import { Facet } from '@gemwright/common/facet';
import { Hues } from '@gemwright/common/hues';
import { encodePng, type Image } from '@gemwright/common/png';
import { clientSkills } from '@gemwright/common/skill-groups';
import { Tiledata } from '@gemwright/common/tiledata';

// The game client's files, drawn for the pages: gumps, item art and radar squares as PNGs (kept
// once drawn), item tile data, and the client's skill names and groups.
export class ClientFiles {
  readonly tiles: Tiledata;
  readonly skills: ReturnType<typeof clientSkills>;
  private readonly gumps: GumpArt;
  private readonly art: ItemArt;
  private readonly hues: Hues;
  private readonly facets = new Map<number, Facet>();
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

  radar(map: number, x: number, y: number, size: number) {
    let facet = this.facets.get(map);
    if (!facet) {
      facet = new Facet(this.directory, map);
      this.facets.set(map, facet);
    }
    return encodePng(facet.radar(x, y, size));
  }
}

// The client files: --files, else the repository's files/ folder when it has them.
export function findClientFiles(given?: string) {
  const repository = fileURLToPath(new URL('../../../files', import.meta.url));
  const directory = given ?? repository;
  return existsSync(join(directory, 'gumpartLegacyMUL.uop')) ? new ClientFiles(directory) : undefined;
}
