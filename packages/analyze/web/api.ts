import type { Doc } from '../src/doc';
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
  page: (path: string) => call<Doc>(`/api/page${path}`)
};
