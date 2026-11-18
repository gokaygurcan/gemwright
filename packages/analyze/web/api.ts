import type { Doc } from '../src/doc';
import type { LabResident } from '../src/lab/routes';
import type { LabResponse, Scenario, SpanRequest, SpanStatus } from '../src/lab/types';
import type { MapResponse } from '../src/map';
import type { PullsResponse } from '../src/pulls-api';

// The analyzer server's JSON API (src/serve.ts).
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error ?? `${response.status} ${response.statusText}`, response.status);
  return body as T;
}

export const api = {
  pulls: () => call<PullsResponse>('/api/pulls'),
  fetchPull: () => call<PullsResponse>('/api/pulls', { method: 'POST' }),
  openPull: (stamp: string) => call<PullsResponse>(`/api/pulls/${stamp}/open`, { method: 'POST' }),
  deletePull: (stamp: string) => call<PullsResponse>(`/api/pulls/${stamp}`, { method: 'DELETE' }),
  // A page of the open pull, by its path in the app (/players, /mobile/12, /search?q=...).
  page: (path: string) => call<Doc>(`/api/page${path}`),
  act: (post: string) => call<unknown>(`/api${post}`, { method: 'POST' }),
  map: (map: number) => call<MapResponse>(`/api/map/${map}`),
  lab: {
    residents: () => call<LabResident[]>('/api/lab/residents'),
    at: (resident: string, at: number) => call<{ id?: number }>(`/api/lab/at?resident=${resident}&at=${at}`),
    weigh: (id: number, scenario: Scenario) =>
      call<LabResponse & { near: { previous?: number; next?: number } }>('/api/lab/weigh', {
        method: 'POST',
        body: JSON.stringify({ id, scenario })
      }),
    span: () => call<SpanStatus | null>('/api/lab/span'),
    startSpan: (request: SpanRequest) =>
      call<{ started: boolean }>('/api/lab/span', { method: 'POST', body: JSON.stringify(request) }),
    stopSpan: () => call<{ stopped: boolean }>('/api/lab/span/stop', { method: 'POST' })
  }
};
