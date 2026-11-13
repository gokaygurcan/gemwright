import { expect, test } from 'bun:test';

import type { PlayerSession } from '@gemwright/network/session';

import type { HistoryEvent } from '../src/v2/history';
import { Mind } from '../src/v2/mind';
import { options } from '../src/v2/options';
import { traitsOf } from '../src/v2/traits';
import { seeing } from './fixtures/v2/mind-sync';

const traits = traitsOf([], () => 0.5).traits;
const event = (at: number, kind: string, data: object): HistoryEvent => ({ resident: 'r', at, kind, data });
const menu = (buttons: number[]) =>
  buttons.map((button, index) => `{ button 40 ${60 + index * 24} 4005 4007 1 0 ${button} }`).join(' ');

// The trade tools of four systems, as the rules mark them (DefBlacksmithy, DefCarpentry,
// DefTinkering, DefTailoring): the resident carries them, and the shard answers a use with a menu
// of its own, to a resident with some skill in each craft. Nothing below names a trade: the same
// rules and answers carry all of them.
const tools = [
  { serial: 10, graphic: 5091, name: 'SmithHammer', gump: 41, buttons: [21] },
  { serial: 11, graphic: 4136, name: 'DovetailSaw', gump: 42, buttons: [31, 32] },
  { serial: 12, graphic: 7864, name: 'TinkerTools', gump: 43, buttons: [41] },
  { serial: 13, graphic: 3997, name: 'SewingKit', gump: 44, buttons: [51] }
];

function presence(tool: (typeof tools)[number]) {
  return {
    serial: tool.serial,
    kind: 'item',
    graphic: tool.graphic,
    parent: 2,
    is: [tool.name]
  };
}

function worldWith(extra: [number, object][] = []) {
  return {
    serial: 1,
    position: { x: 10, y: 10, z: 0, direction: 0 },
    entities: new Map<number, object>([
      [2, { serial: 2, kind: 'item', graphic: 3701, parent: 1, layer: 21 }],
      ...tools.map(
        (tool) => [tool.serial, { serial: tool.serial, kind: 'item', graphic: tool.graphic, parent: 2 }] as const
      ),
      ...extra
    ])
  };
}

test('a carried tool is tried once, and the menu it answers with becomes the interactions it offers, in every craft it has skill in', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(
    event(0, 'awake', { serial: 1, self: {}, skills: { Blacksmith: 10, Carpentry: 10, Tinkering: 10, Tailoring: 10 } })
  );
  for (const tool of tools) mind.observe(event(0, 'revealed', presence(tool)));
  const session = { world: worldWith() } as unknown as PlayerSession;

  // Before anything is tried, each trade tool offers exactly one thing: using it, to see what it
  // does. No trade is named, because none needs naming.
  const probes = options(seeing(mind, session), undefined, new Set());
  expect(probes.map((option) => option.key).sort()).toEqual(tools.map((tool) => `double-click my ${tool.name}`).sort());
  for (const probe of probes) {
    expect(probe.steps).toHaveLength(1);
    expect(probe.value).toBeGreaterThan(0);
  }

  // It tries three of them; each answers with its own menu, whose buttons become its interactions.
  for (const [index, tool] of tools.slice(0, 3).entries()) {
    mind.observe(event(10 + index * 2, 'acted', { verb: 'double-click', serial: tool.serial }));
    mind.observe(
      event(11 + index * 2, 'gump', {
        key: `${tool.serial}:${tool.gump}`,
        value: { serial: tool.serial, id: tool.gump, packed: false, layout: menu(tool.buttons) }
      })
    );
  }
  const found = options(seeing(mind, session), undefined, new Set());
  for (const tool of tools.slice(0, 3)) {
    for (const button of tool.buttons) {
      const key = `double-click my ${tool.name} > gump-response ${tool.gump}:${button}`;
      const option = found.find((entry) => entry.key === key);
      expect(option).toBeDefined();
      expect(option?.steps).toEqual([
        { verb: 'use', serial: tool.serial, gump: tool.gump },
        { verb: 'gump-response', serial: tool.serial, gump: tool.gump, button }
      ]);
    }
    expect(found.some((entry) => entry.key === `double-click my ${tool.name}`)).toBe(false);
  }

  // The one tried that answered with nothing is not tried again, and offers nothing either.
  const dumb = tools[3] as (typeof tools)[number];
  mind.observe(event(30, 'acted', { verb: 'double-click', serial: dumb.serial }));
  mind.observe(event(31, 'acted', { verb: 'walk', direction: 2, sequence: 0 }));
  expect(mind.tried(dumb.name)).toBe(true);
  const after = options(seeing(mind, session), undefined, new Set());
  expect(after.some((entry) => entry.key === `double-click my ${dumb.name}`)).toBe(false);
  expect(after.some((entry) => entry.key.includes(dumb.name))).toBe(false);
});

test('a tool whose use asks for a target is offered the station it works at, seen in the world', () => {
  const mind = new Mind('r', () => {}, traits);
  mind.observe(
    event(0, 'awake', { serial: 1, self: {}, skills: { Blacksmith: 10, Carpentry: 10, Tinkering: 10, Tailoring: 10 } })
  );
  const hammer = tools[0] as (typeof tools)[number];
  mind.observe(event(0, 'revealed', presence(hammer)));
  mind.observe(
    event(0, 'seen', {
      serial: 70,
      kind: 'item',
      graphic: 4015,
      x: 12,
      y: 10,
      z: 0,
      is: ['ColoredAnvil', 'Anvil']
    })
  );
  const session = {
    world: worldWith([[70, { serial: 70, kind: 'item', graphic: 4015, position: { x: 12, y: 10, z: 0 } }]])
  } as unknown as PlayerSession;

  // Its use answered with a cursor rather than a menu: the tool works on something shown to it.
  mind.observe(event(1, 'acted', { verb: 'double-click', serial: hammer.serial }));
  mind.observe(event(2, 'screen', { key: 'cursor', value: { id: 1, ground: true, flags: 0 } }));

  const found = options(seeing(mind, session), undefined, new Set());
  const station = found.find((entry) => entry.key === 'double-click my SmithHammer > target ColoredAnvil/Anvil');
  expect(station).toBeDefined();
  expect(station?.steps).toEqual([
    { verb: 'use', serial: hammer.serial },
    { verb: 'target', serial: 70 }
  ]);
  expect(found.some((entry) => entry.key === 'double-click my SmithHammer')).toBe(false);
});
