import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Doc, link } from './doc';

// One resident's recent life, to see why it did what it did: the last fifty steps it remembers
// (checkpoint memories), its setbacks with their reasons and how often each repeated, and its
// lines from the AI log the pull brought along (<pull>/logs/ai.log, the last few minutes).
export function replayDoc(saves: string, serial: number): Doc | undefined {
  const db = join(saves, '../../ai/residents.sqlite');
  if (!existsSync(db)) return undefined;
  const store = new Database(db, { readonly: true });
  let row: { name: string; template: string; checkpoint: string } | null;
  try {
    row = store
      .query<{ name: string; template: string; checkpoint: string }, [string]>(
        "SELECT proposed_name AS name, template_id AS template, checkpoint_json AS checkpoint FROM residents WHERE json_extract(binding_json, '$.characterSerial') = ?"
      )
      .get(String(serial));
  } finally {
    store.close();
  }
  if (!row) return undefined;
  const checkpoint = JSON.parse(row.checkpoint) as {
    memories?: { at: string; text: string }[];
    objectives?: Record<string, { failures: number; until: number; reason: string }>;
    goal?: { phase?: string; note?: string } | null;
  };
  const logFile = join(saves, '../../logs/ai.log');
  const tag = `:${row.name}]`;
  const lines = existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes(tag) && !/running at|Movement rejected/.test(line))
        .slice(-200)
    : [];
  return {
    title: row.name,
    subtitle: [
      row.template,
      `now: ${checkpoint.goal?.phase ?? ''} ${checkpoint.goal?.note ?? ''}`,
      link('character', `/mobile/${serial}`)
    ],
    blocks: [
      { kind: 'heading', text: 'Recent steps (newest first, UTC)' },
      {
        kind: 'table',
        head: ['Time', 'Step'],
        empty: 'None kept.',
        rows: [...(checkpoint.memories ?? [])].reverse().map((m) => [m.at.slice(11, 19), m.text])
      },
      { kind: 'heading', text: 'Setbacks' },
      {
        kind: 'table',
        head: ['Times', 'Reason', ''],
        numeric: [0],
        empty: 'None.',
        rows: Object.values(checkpoint.objectives ?? {})
          .sort((a, b) => b.failures - a.failures)
          .slice(0, 30)
          .map((o) => [o.failures, o.reason, o.until > Date.now() ? 'waiting' : ''])
      },
      { kind: 'heading', text: 'Log lines in this pull' },
      { kind: 'pre', text: lines.join('\n') || 'None.' }
    ]
  };
}
