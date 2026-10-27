import { useEffect, useState } from 'preact/hooks';

import type { PullsResponse } from '../src/pulls-api';
import { api } from './api';
import { navigate } from './router';

// The opening page: every pull, newest first, to analyze or delete, and fetching a new one.
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
function ago(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

type Pull = PullsResponse['pulls'][number];

function PullRow({ pull, current, onChange }: { pull: Pull; current: boolean; onChange: (r: PullsResponse) => void }) {
  const [state, setState] = useState<'idle' | 'opening' | 'confirm' | 'deleting'>('idle');
  const [error, setError] = useState<string>();
  const analyze = async () => {
    setState('opening');
    setError(undefined);
    try {
      onChange(await api.openPull(pull.stamp));
      navigate('/overview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('idle');
    }
  };
  const remove = async () => {
    setState('deleting');
    try {
      onChange(await api.deletePull(pull.stamp));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('idle');
    }
  };
  return (
    <li class={`pull${current ? ' current' : ''}`}>
      <div class="pull-when">
        <strong>{when(pull.at)}</strong>
        <span class="muted">
          {ago(pull.at)} · {size(pull.bytes)}
        </span>
      </div>
      <div class="pull-parts">
        {pull.parts.map((p) => (
          <span class="tag" key={p}>
            {p}
          </span>
        ))}
        {pull.failed.map((p) => (
          <span class="tag tag-error" key={p}>
            {p} failed
          </span>
        ))}
        {current && <span class="tag tag-open">open</span>}
      </div>
      <div class="pull-actions">
        {state === 'confirm' || state === 'deleting' ? (
          <>
            <span>Delete this pull?</span>
            <button class="danger" disabled={state === 'deleting'} onClick={remove} type="button">
              {state === 'deleting' ? 'Deleting…' : 'Delete'}
            </button>
            <button disabled={state === 'deleting'} onClick={() => setState('idle')} type="button">
              Cancel
            </button>
          </>
        ) : (
          <>
            {pull.saves ? (
              <button class="primary" disabled={state === 'opening'} onClick={analyze} type="button">
                {state === 'opening' ? 'Reading…' : current ? 'Open' : 'Analyze'}
              </button>
            ) : (
              <span class="muted">no world save</span>
            )}
            {!current && (
              <button class="quiet" onClick={() => setState('confirm')} type="button">
                Delete
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <p class="tone-error pull-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function PullsPage({ data, onChange }: { data?: PullsResponse; onChange: (r: PullsResponse) => void }) {
  const [error, setError] = useState<string>();
  const running = data?.pulling.running ?? false;
  // While a pull runs, its progress is polled.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => api.pulls().then(onChange, () => {}), 1500);
    return () => clearInterval(timer);
  }, [running, onChange]);
  const fetchNew = () => api.fetchPull().then(onChange, (e) => setError(String(e?.message ?? e)));
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Pulls</h1>
          <p class="muted">Snapshots of the shard taken with gemwright pull. Analyze one to browse it.</p>
        </div>
        <button class="primary" disabled={running} onClick={fetchNew} type="button">
          {running ? 'Pulling…' : 'Fetch new pull'}
        </button>
      </div>
      {(error || data?.pulling.error) && (
        <p class="tone-error" role="alert">
          {error ?? data?.pulling.error}
        </p>
      )}
      {running && (
        <div class="progress" role="status">
          <p>Pulling the shard’s latest state. This takes a few minutes.</p>
          <pre>{data?.pulling.lines.slice(-8).join('\n') || 'Starting…'}</pre>
        </div>
      )}
      {!data ? (
        <p class="muted">Loading…</p>
      ) : data.pulls.length ? (
        <ul class="pulls">
          {data.pulls.map((p) => (
            <PullRow current={p.stamp === data.open?.stamp} key={p.stamp} onChange={onChange} pull={p} />
          ))}
        </ul>
      ) : (
        <p class="muted">No pulls here yet. Fetch one to start.</p>
      )}
    </>
  );
}
