import { expect, test } from 'bun:test';

// The cemetery list resolves each ground's gate at load; loading it first keeps the
// moongate/cemetery import cycle in its production order (see cemeteries.ts).
import '../src/cemeteries';
import { forgeSites, serviceLocations } from '../src/locations';
import { workArea } from '../src/work-areas';

test('miners are only assigned to districts whose town can bank and smelt', () => {
  const usable = (area: { city: string }) =>
    serviceLocations(area.city, 'banker').length > 0 &&
    forgeSites.some((forge) => forge.city.toLowerCase() === area.city.toLowerCase());
  const cities = new Set(
    Array.from({ length: 200 }, (_, index) => workArea('mining', `Miner-${index}`, 'Britain', usable).city)
  );
  expect(cities.has('Cove')).toBe(false);
  expect(cities.has('Minoc')).toBe(true);
  // New Haven keeps its own residents in their own mountains.
  expect(workArea('mining', 'Miner-new-haven', 'New Haven', usable).city).toBe('New Haven');
});
