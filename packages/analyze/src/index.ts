import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { analyze, exportData } from './analysis';
import { characterReport } from './character';
import { newestPull } from './pulls';
import { report } from './report';

// A pulled world save (gemwright pull) made readable.
//   bun packages/analyze/src/index.ts [--saves <Saves folder>] [--output report.md]
//     [--character <name or serial>] [--json <file>]
// Without --saves: the newest pull under ./.gemwright/pulls. --character prints one character
// in full instead of the report; --json also writes every character and item as data.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    saves: { type: 'string' },
    output: { type: 'string' },
    character: { type: 'string' },
    json: { type: 'string' }
  }
});

const analysis = analyze(resolve(values.saves ?? newestPull()));
if (values.json) {
  writeFileSync(values.json, `${JSON.stringify(exportData(analysis))}\n`);
  console.log(`Wrote ${values.json}`);
}
let text: string;
if (values.character) {
  const wanted = values.character.toLowerCase();
  const found = analysis.characters.filter((c) => String(c.serial) === wanted || c.name.toLowerCase() === wanted);
  if (!found.length) throw new Error(`No player character named ${values.character}.`);
  text = found.map(characterReport).join('\n\n');
} else text = report(analysis);
if (values.output) {
  writeFileSync(values.output, `${text}\n`);
  console.log(`Wrote ${values.output}`);
} else if (!values.json || values.character) console.log(text);
