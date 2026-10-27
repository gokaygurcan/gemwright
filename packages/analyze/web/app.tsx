import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import type { Doc } from '../src/doc';
import type { PullsResponse } from '../src/pulls-api';
import { ApiError, api } from './api';
import { BlockView, CellView } from './blocks';
import { PullsPage } from './pulls';
import { navigate, useLocation } from './router';

// The analyzer app: the pulls page at /, and the open pull's pages everywhere else, each one a
// document from the server (src/doc.ts).
const SECTIONS = [
  ['/overview', 'Overview'],
  ['/players', 'Players'],
  ['/residents', 'Residents'],
  ['/trouble', 'Trouble'],
  ['/loops', 'Loops'],
  ['/history', 'History'],
  ['/economy', 'Economy'],
  ['/decisions', 'Decisions']
] as const;

function DocPage({ path }: { path: string }) {
  const [doc, setDoc] = useState<Doc>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setError(undefined);
    api.page(path).then(
      (d) => {
        if (!live) return;
        setDoc(d);
        document.title = `${d.title} · Gemwright analyzer`;
      },
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 409) navigate('/', true);
        else setError(e instanceof Error ? e.message : String(e));
      }
    );
    return () => {
      live = false;
    };
  }, [path]);
  if (error)
    return (
      <p class="tone-error" role="alert">
        {error}
      </p>
    );
  if (!doc) return <p class="muted">Loading…</p>;
  return (
    <article>
      <h1>{doc.title}</h1>
      {doc.subtitle && (
        <p class="muted subtitle">
          {doc.subtitle.map((c, i) => (
            <span key={i}>
              <CellView cell={c} />
            </span>
          ))}
        </p>
      )}
      {doc.blocks.map((b, i) => (
        <BlockView block={b} key={i} />
      ))}
    </article>
  );
}

function Search({ path }: { path: string }) {
  const initial = path.startsWith('/search') ? (new URLSearchParams(path.split('?')[1]).get('q') ?? '') : '';
  const [query, setQuery] = useState(initial);
  useEffect(() => setQuery(initial), [initial]);
  return (
    <form
      class="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
      }}
    >
      <input
        aria-label="Search the pull"
        onInput={(e) => setQuery(e.currentTarget.value)}
        placeholder="Name, type or serial"
        type="search"
        value={query}
      />
    </form>
  );
}

function App() {
  const path = useLocation();
  const [pulls, setPulls] = useState<PullsResponse>();
  const update = useCallback((r: PullsResponse) => setPulls(r), []);
  useEffect(() => {
    api.pulls().then(update, () => {});
  }, [update]);
  const open = pulls?.open;
  const home = path === '/' || path === '';
  useEffect(() => {
    if (home) document.title = 'Pulls · Gemwright analyzer';
  }, [home]);
  return (
    <>
      <header class="top">
        <div class="bar">
          <a class="brand" href="/">
            Gemwright <span>analyzer</span>
          </a>
          {open && <Search path={path} />}
          {open && (
            <span class="open-pull muted" title={open.label}>
              {new Date(open.savedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          )}
        </div>
        {open && (
          <nav aria-label="Sections">
            <a class={home ? 'active' : undefined} href="/">
              Pulls
            </a>
            {SECTIONS.map(([href, label]) => (
              <a class={path.startsWith(href) ? 'active' : undefined} href={href} key={href}>
                {label}
              </a>
            ))}
          </nav>
        )}
      </header>
      <main>{home ? <PullsPage data={pulls} onChange={update} /> : <DocPage path={path} />}</main>
    </>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
