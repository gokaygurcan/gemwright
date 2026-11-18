import { Database } from 'bun:sqlite';

import type { Lived } from '../lived';
import type { Runs } from '../runs';
import type { Lab } from './lab';
import type { Scenario, SpanRequest } from './types';

// The lab's API (web/lab.tsx): the residents it can make decisions again for, a resident's decision
// nearest a moment, one decision weighed as it was and with a scenario changed, and a scenario over
// many decisions.
type Opened = { lived?: Lived; runs?: Runs; lab?: Lab } | undefined;

export interface LabResident {
  id: string;
  name: string;
  // Minds its run kept: none, and its decisions cannot be made again yet.
  kept: number;
  run?: string;
  first?: number;
  last?: number;
}

const fail = (error: string, status = 409) => Response.json({ error }, { status });

export function labRoutes(opened: () => Opened) {
  const using = async (make: (o: Required<NonNullable<Opened>>) => unknown | Promise<unknown>) => {
    const o = opened();
    if (!o) return fail('No pull is open.');
    if (!o.lived || !o.runs || !o.lab)
      return fail('The lab needs a pull with history and the client’s files (--files).');
    try {
      return Response.json(await make(o as Required<NonNullable<Opened>>));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 500);
    }
  };
  return {
    '/api/lab/residents': () =>
      using(({ lived, runs, lab }) => {
        const db = new Database(lived.file, { readonly: true });
        try {
          const edge = (resident: string, order: 'ASC' | 'DESC') =>
            ['considered', 'reconsidered']
              .flatMap(
                (kind) =>
                  db
                    .query<{ id: number; at: number }, [string, string]>(
                      `SELECT id, at FROM events WHERE resident = ? AND kind = ? ORDER BY at ${order} LIMIT 1`
                    )
                    .get(resident, kind) ?? []
              )
              .sort((a, b) => (order === 'ASC' ? a.at - b.at : b.at - a.at))[0]?.id;
          return [...lived.residents.values()]
            .map(
              (r): LabResident => ({
                id: r.id,
                name: r.name,
                kept: lab.kept(r.id),
                run: runs.state(r.id)?.status,
                first: edge(r.id, 'ASC'),
                last: edge(r.id, 'DESC')
              })
            )
            .filter((r) => r.last !== undefined)
            .sort((a, b) => a.name.localeCompare(b.name));
        } finally {
          db.close();
        }
      }),
    // The resident's decision nearest before a moment (epoch ms).
    '/api/lab/at': (request: Request) =>
      using(({ lived }) => {
        const query = new URL(request.url).searchParams;
        const db = new Database(lived.file, { readonly: true });
        try {
          return {
            id: ['considered', 'reconsidered']
              .flatMap(
                (kind) =>
                  db
                    .query<{ id: number; at: number }, [string, string, number]>(
                      'SELECT id, at FROM events WHERE resident = ? AND kind = ? AND at <= ? ORDER BY at DESC LIMIT 1'
                    )
                    .get(query.get('resident') ?? '', kind, Number(query.get('at'))) ?? []
              )
              .sort((a, b) => b.at - a.at)[0]?.id
          };
        } finally {
          db.close();
        }
      }),
    '/api/lab/weigh': {
      POST: async (request: Request) => {
        const body = (await request.json()) as { id: number; scenario?: Scenario };
        return using(({ lab }) => lab.weigh(Number(body.id), body.scenario ?? {}));
      }
    },
    '/api/lab/span': {
      GET: () => using(({ lab }) => lab.spanStatus() ?? null),
      POST: async (request: Request) => {
        const body = (await request.json()) as SpanRequest;
        return using(({ lab }) => {
          lab.startSpan(body).catch((error: unknown) => console.error(`[lab] span failed: ${error}`));
          return { started: true };
        });
      }
    },
    '/api/lab/span/stop': {
      POST: () =>
        using(({ lab }) => {
          lab.stopSpan();
          return { stopped: true };
        })
    }
  };
}
