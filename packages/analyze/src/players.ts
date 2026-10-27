import type { Analysis } from './analysis';
import { type Doc, link, num } from './doc';

// Every player character in one table, to filter by name and sort by any column.
export function playersDoc(a: Analysis): Doc {
  return {
    title: 'Players',
    subtitle: [`${a.characters.length} characters`],
    blocks: [
      {
        kind: 'table',
        head: ['Name', 'Kind', 'Skill total', 'Stat total', 'Gold'],
        numeric: [2, 3, 4],
        interactive: true,
        rows: [...a.characters]
          .sort((x, y) => y.skillTotal - x.skillTotal)
          .map((c) => [
            link(c.name, `/mobile/${c.serial}`),
            c.resident ? 'resident' : 'player',
            num(c.skillTotal, 1),
            num(c.stats.str + c.stats.dex + c.stats.int),
            num(c.gold.carried + c.gold.bankBalance + c.gold.bankCoins + c.gold.checks)
          ])
      }
    ]
  };
}
