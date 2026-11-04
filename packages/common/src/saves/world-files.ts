import type { World } from './servuo';

// ServUO map indexes (Map.Felucca 0 ... Map.TerMur 5), named as spawner files name them.
const MAPS = ['Felucca', 'Trammel', 'Ilshenar', 'Malas', 'Tokuno', 'TerMur'];
const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The spawners placed in a world save, in the layout of the XmlSpawner files `[createworld` loads
// (Spawns/*.xml): what is really out in the world, with whatever was added, moved or changed in game.
export function savedSpawnersXml(world: World): { xml: string; spawners: number } {
  const points: string[] = [];
  for (const item of world.items.values()) {
    const map = MAPS[item.map];
    if (!item.spawner || item.parent !== undefined || !map) continue;
    const objects = item.spawner.spawns.map((spawn) => `${xmlText(spawn.type)}:MX=${spawn.max}`).join(':OBJ=');
    points.push(
      `  <Points>\n    <Name>${xmlText(item.name ?? '')}</Name>\n    <Map>${map}</Map>\n` +
        `    <CentreX>${item.location.x}</CentreX>\n    <CentreY>${item.location.y}</CentreY>\n` +
        `    <CentreZ>${item.location.z}</CentreZ>\n    <Range>${item.spawner.homeRange}</Range>\n` +
        `    <MaxCount>${item.spawner.count}</MaxCount>\n` +
        `    <Objects2>${objects}</Objects2>\n  </Points>`
    );
  }
  return {
    xml: `<?xml version="1.0" standalone="yes"?>\n<Spawns>\n${points.join('\n')}\n</Spawns>\n`,
    spawners: points.length
  };
}

// The fixed items lying in Trammel's world in a save (on the ground, not movable), in the layout of
// the decoration files `[decorate` loads (Data/Decoration/*.cfg): the forges, ankhs, spinning wheels
// and looms that really stand there.
export function savedDecoration(world: World): { cfg: string; placements: number } {
  const byKind = new Map<string, string[]>();
  for (const item of world.items.values()) {
    if (item.parent !== undefined || item.movable || item.map !== 1) continue;
    const kind = `${item.type.split('.').at(-1)} 0x${item.graphic.toString(16).toUpperCase()}`;
    byKind.set(kind, [...(byKind.get(kind) ?? []), `${item.location.x} ${item.location.y} ${item.location.z}`]);
  }
  const blocks = [...byKind].map(([kind, points]) => `${kind}\n${points.join('\n')}`);
  return { cfg: `${blocks.join('\n\n')}\n`, placements: [...byKind.values()].reduce((n, p) => n + p.length, 0) };
}
