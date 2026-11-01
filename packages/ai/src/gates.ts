import { areaHere, areaOfPlace, gateArea } from './areas';

// Trammel public moongates on the pinned shard (PublicMoongate.PMList.Trammel): gate location and
// the destination's label in the gate menu. Arrival is at the destination gate itself.
export const moongates = {
  moonglow: { x: 4467, y: 1283, z: 5, label: 1012003 },
  britain: { x: 1336, y: 1997, z: 5, label: 1012004 },
  jhelom: { x: 1499, y: 3771, z: 5, label: 1012005 },
  yew: { x: 771, y: 752, z: 5, label: 1012006 },
  minoc: { x: 2701, y: 692, z: 5, label: 1012007 },
  trinsic: { x: 1828, y: 2948, z: -20, label: 1012008 },
  skara: { x: 643, y: 2067, z: 5, label: 1012009 },
  // PublicMoongate.cs PMEntry for New Haven (Trammel).
  newhaven: { x: 3450, y: 2677, z: 25, label: 1078098 }
} as const;
export type Gate = keyof typeof moongates;

// Tiles apart as a walker counts them (navigation.ts distance); kept here so this module stays a leaf.
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export const nearestGate = (point: { x: number; y: number }): Gate => {
  const area = areaOfPlace(point) ?? areaHere(point);
  const gates = Object.keys(moongates) as Gate[];
  const own = area === undefined ? [] : gates.filter((gate) => gateArea(moongates[gate]) === area);
  return (
    [...(own.length ? own : gates)].sort((a, b) => distance(point, moongates[a]) - distance(point, moongates[b]))[0] ??
    'britain'
  );
};
