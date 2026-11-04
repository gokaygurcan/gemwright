import { moongateList } from '@gemwright/common/game/rules';

import { areaHere, areaOfPlace, gateArea } from './areas';

// Trammel public moongates from the ServUO rules (PublicMoongate.PMList.Trammel): gate location and
// the destination's label in the gate menu. Arrival is at the destination gate itself.
export const moongates = moongateList;
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
