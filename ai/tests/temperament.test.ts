import { expect, test } from 'bun:test';

import { validateConfig } from '../src/config';
import { personalTemplate, temperamentOf } from '../src/temperament';
import example from '../templates/population.example.json';

test('temperament is stable per resident and differs between residents', () => {
  expect(temperamentOf('a')).toEqual(temperamentOf('a'));
  const ids = Array.from({ length: 10 }, (_, index) => `resident-${index}`);
  const distinct = new Set(ids.map((id) => JSON.stringify(temperamentOf(id))));
  expect(distinct.size).toBe(10);
});

test('personal templates shade policy within bounds without touching the shared template', () => {
  const template = validateConfig(example).templates[1];
  if (!template) throw new Error('missing template');
  const before = structuredClone(template);
  const personal = personalTemplate(template, 'resident-3');
  expect(template).toEqual(before);
  expect(personal.behavior.riskTolerance).toBeGreaterThanOrEqual(0);
  expect(personal.behavior.riskTolerance).toBeLessThanOrEqual(1);
  expect(Math.abs(personal.behavior.riskTolerance - template.behavior.riskTolerance)).toBeLessThanOrEqual(0.15);
  expect(personal.behavior.temperament?.carriedGold).toBeGreaterThanOrEqual(800);
});
