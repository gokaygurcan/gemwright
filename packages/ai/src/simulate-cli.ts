import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { History } from './history';
import { prepareLand } from './land';
import { checkWakes, simulate } from './simulate';

// Weighs a traced decision again from what the resident knew then (simulate.ts), and prints whether
// it comes to the same result, as JSON. Read-only; runs where the history lives, beside the world
// it was lived in (the AI container's data folder):
//   bun dist/simulate-cli.js --data /app/data --id <considered or reconsidered event id>
// --check <resident> instead rebuilds each of its wakings up to the next and compares the mind.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { data: { type: 'string' }, id: { type: 'string' }, check: { type: 'string' } }
});
const data = values.data ?? process.env.AI_DATA ?? '/app/data';
const id = Number(values.id);
if (!Number.isInteger(id) && !values.check) throw new Error('--id or --check <resident> is required');
const shard = (await Bun.file(join(data, 'gemwright.json')).json()) as { ai?: { cities?: string[] } };
await prepareLand(data, shard.ai?.cities);
const history = new History(join(data, 'history.sqlite'), true);
try {
  console.log(JSON.stringify(values.check ? checkWakes(history, values.check) : simulate(history, id)));
} finally {
  history.close();
}
