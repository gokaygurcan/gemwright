// ServUO's region definitions (Data/Regions.xml): every named region on every facet, its type
// (TownRegion, DungeonRegion, GuardedRegion...), the region it lies in and its own rectangles.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Region {
  facet: string;
  name: string;
  type: string;
  parent?: string;
  rects: Rect[];
}

const attribute = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

export function parseRegions(xml: string): Region[] {
  const regions: Region[] = [];
  const open: (Region | undefined)[] = [];
  let facet = '';
  for (const [tag, closing, element = '', attrs = '', selfClosing] of xml.matchAll(
    /<(\/?)(Facet|region|rect)\b([^>]*?)(\/?)>/g
  )) {
    if (element === 'Facet') facet = closing ? '' : (attribute(attrs, 'name') ?? '');
    else if (element === 'region' && closing) open.pop();
    else if (element === 'region') {
      const name = attribute(attrs, 'name');
      const region = name
        ? {
            facet,
            name,
            type: attribute(attrs, 'type') ?? '',
            ...(open.findLast(Boolean)?.name && { parent: open.findLast(Boolean)?.name }),
            rects: []
          }
        : undefined;
      if (region) regions.push(region);
      if (!selfClosing && !tag.endsWith('/>')) open.push(region);
    } else if (element === 'rect' && !closing) {
      const n = (key: string) => Number(attribute(attrs, key));
      open.at(-1)?.rects.push({ x: n('x'), y: n('y'), width: n('width'), height: n('height') });
    }
  }
  return regions;
}

export const inRect = (rect: Rect, p: { x: number; y: number }) =>
  p.x >= rect.x && p.x < rect.x + rect.width && p.y >= rect.y && p.y < rect.y + rect.height;

// The innermost named regions a point lies in on a facet, innermost first.
export function regionsAt(regions: readonly Region[], facet: string, p: { x: number; y: number }): Region[] {
  const here = regions.filter((r) => r.facet === facet && r.rects.some((rect) => inRect(rect, p)));
  const depth = (r: Region): number => {
    const parent = r.parent && here.find((o) => o.name === r.parent);
    return parent ? 1 + depth(parent) : 0;
  };
  return here.sort((a, b) => depth(b) - depth(a));
}
