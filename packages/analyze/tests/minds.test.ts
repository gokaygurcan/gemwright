import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mindsDoc } from '../src/minds';

// A pull's v2 history with what one resident last wrote down of where it is, what it is and what it
// has: the minds page shows all three.
test('each mind shows where it is, what it is and what it has', () => {
  const root = mkdtempSync(join(tmpdir(), 'minds-'));
  try {
    mkdirSync(join(root, 'ai'));
    mkdirSync(join(root, 'world', 'Saves'), { recursive: true });
    const db = new Database(join(root, 'ai', 'history.sqlite'));
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, resident TEXT, at INTEGER, kind TEXT, data TEXT)');
    const add = (kind: string, data: object) =>
      db
        .query('INSERT INTO events (resident, at, kind, data) VALUES (?, ?, ?, ?)')
        .run('r1', 1000, kind, JSON.stringify(data));
    add('place', {
      map: 1,
      regions: ['the New Haven Bank', 'New Haven'],
      kind: 'town',
      guarded: true,
      island: 'Haven Island',
      part: 'north'
    });
    add('abilities', {
      skills: { Mining: { value: 80, base: 80, cap: 100, lock: 0 } },
      stats: { strength: 100, dexterity: 50, intelligence: 25 },
      statLocks: [0, 1, 2],
      statCap: 225,
      weapons: [],
      crafts: [{ skill: 'Blacksmith', value: 40 }],
      parry: { shield: 0, oneHanded: 0, twoHanded: 0 },
      tames: [],
      carries: 120,
      growth: { total: 80, cap: 700, rising: [{ skill: 'Mining', gained: 0.3 }] }
    });
    add('holding', {
      worn: {},
      pack: { resource: { amount: 40, worth: 120, weight: 40 } },
      bank: {},
      ground: 0,
      corpses: 0
    });
    db.close();
    const text = JSON.stringify(mindsDoc(join(root, 'world', 'Saves')).blocks);
    expect(text).toContain('north of the New Haven Bank in New Haven');
    expect(text).toContain('Haven Island');
    expect(text).toContain('str 100 (up), dex 50 (down), int 25 (locked) of 225');
    expect(text).toContain('Mining +0.3');
    expect(text).toContain('resource');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
