import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { MapResponse, MarkerKind } from '../src/map';
import { ApiError, api } from './api';
import { navigate } from './router';

// The world map: the facet drawn from the client's radar colours in 256-pixel tiles (the server's
// /maptile, one pixel per 2^level tiles), dragged and zoomed like any web map, with the pull's
// characters, houses and the residents' trouble on top. /map?m=1&px=..&py=.. opens on a place and
// pins it; x, y and z (the zoom) keep the view in the address.
const FACETS = [
  [0, 'Felucca'],
  [1, 'Trammel'],
  [2, 'Ilshenar'],
  [3, 'Malas'],
  [4, 'Tokuno'],
  [5, 'Ter Mur']
] as const;
const LAYERS: [MarkerKind, string][] = [
  ['resident', 'Residents'],
  ['player', 'Players'],
  ['house', 'Houses and boats'],
  ['trouble', 'Failed walks'],
  ['death', 'Deaths']
];
const DOT: Record<MarkerKind, string> = {
  resident: 'rounded-full bg-resident',
  player: 'rounded-full bg-player',
  house: 'rounded-[2px] bg-house',
  trouble: 'rotate-45 rounded-[2px] bg-trouble',
  death: 'rounded-full bg-death'
};
const LEVELS = 5;
const MIN_SCALE = 1 / 16;
const MAX_SCALE = 8;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

interface View {
  x: number;
  y: number;
  scale: number;
}

export function MapPage({ path }: { path: string }) {
  const params = new URLSearchParams(path.split('?')[1]);
  const map = Number(params.get('m') ?? 1);
  const pin = params.has('px') ? { x: Number(params.get('px')), y: Number(params.get('py')) } : undefined;
  const start = params.has('x') ? { x: Number(params.get('x')), y: Number(params.get('y')) } : pin;
  const zoomed = Number(params.get('z') ?? 2);
  const [data, setData] = useState<MapResponse>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [shown, setShown] = useState<Set<MarkerKind>>(new Set(LAYERS.map(([k]) => k)));
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: View } | undefined>(undefined);

  useEffect(() => {
    document.title = 'Map · Gemwright analyzer';
    let live = true;
    setData(undefined);
    setError(undefined);
    api.map(map).then(
      (d) => live && setData(d),
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 409) navigate('/', true);
        else setError(e instanceof Error ? e.message : String(e));
      }
    );
    return () => {
      live = false;
    };
  }, [map]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [data]);

  useEffect(() => {
    if (!data || !size.width || view) return;
    const fit = clamp(Math.min(size.width / data.width, size.height / data.height), MIN_SCALE, MAX_SCALE);
    setView(
      start
        ? { ...start, scale: clamp(zoomed, MIN_SCALE, MAX_SCALE) }
        : { x: data.width / 2, y: data.height / 2, scale: fit }
    );
  }, [data, size, view, start, zoomed]);

  // The address follows the view, so a reload or a shared link opens the same place.
  useEffect(() => {
    if (!view) return;
    const query = `?m=${map}&x=${Math.round(view.x)}&y=${Math.round(view.y)}&z=${view.scale}`;
    history.replaceState(null, '', `/map${query}${pin ? `&px=${pin.x}&py=${pin.y}` : ''}`);
  }, [view, map, pin]);

  const counts = useMemo(() => {
    const n = new Map<MarkerKind, number>();
    for (const m of data?.markers ?? []) n.set(m.kind, (n.get(m.kind) ?? 0) + 1);
    return n;
  }, [data]);

  if (error)
    return (
      <p class="tone-error" role="alert">
        {error}
      </p>
    );

  const zoom = (factor: number, at = { x: size.width / 2, y: size.height / 2 }) =>
    setView((v) => {
      if (!v) return v;
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      // Keep the tile under the pointer where it is.
      const wx = v.x + (at.x - size.width / 2) / v.scale;
      const wy = v.y + (at.y - size.height / 2) / v.scale;
      return { scale, x: wx - (at.x - size.width / 2) / scale, y: wy - (at.y - size.height / 2) / scale };
    });
  const pan = (dx: number, dy: number) => setView((v) => v && { ...v, x: v.x + dx / v.scale, y: v.y + dy / v.scale });

  const left = view ? view.x - size.width / 2 / view.scale : 0;
  const top = view ? view.y - size.height / 2 / view.scale : 0;
  const tiles = [];
  if (view && data?.drawn) {
    const level = clamp(Math.floor(-Math.log2(view.scale)), 0, LEVELS - 1);
    const span = 256 << level;
    const px = span * view.scale;
    for (
      let ty = Math.max(0, Math.floor(top / span));
      ty * span < Math.min(data.height, top + size.height / view.scale);
      ty++
    )
      for (
        let tx = Math.max(0, Math.floor(left / span));
        tx * span < Math.min(data.width, left + size.width / view.scale);
        tx++
      )
        tiles.push(
          <img
            alt=""
            class="pointer-events-none absolute [image-rendering:pixelated]"
            draggable={false}
            key={`${level}:${tx}:${ty}`}
            src={`/maptile/${map}/${level}/${tx}/${ty}`}
            style={{
              left: `${(tx * span - left) * view.scale}px`,
              top: `${(ty * span - top) * view.scale}px`,
              width: `${px}px`,
              height: `${px}px`
            }}
          />
        );
  }
  // Preact 11 takes style lengths with their units.
  const at = (p: { x: number; y: number }) =>
    view && { left: `${(p.x - left) * view.scale}px`, top: `${(p.y - top) * view.scale}px` };
  const inView = (x: number, y: number) =>
    view && x >= left && y >= top && x <= left + size.width / view.scale && y <= top + size.height / view.scale;
  const markers = view && data ? data.markers.filter((m) => shown.has(m.kind) && inView(m.x, m.y)) : [];

  return (
    <div>
      <div class="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <label>
          <span class="text-muted">Facet </span>
          <select
            class="rounded-box border border-line bg-surface px-2 py-1.5"
            onChange={(e) => navigate(`/map?m=${e.currentTarget.value}`)}
            value={map}
          >
            {FACETS.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <fieldset class="m-0 flex flex-wrap gap-x-4 gap-y-1 border-0 p-0">
          <legend class="sr-only">Show on the map</legend>
          {LAYERS.map(([kind, label]) => (
            <label class="inline-flex cursor-pointer items-center gap-1.5" key={kind}>
              <input
                checked={shown.has(kind)}
                onChange={() =>
                  setShown((s) => {
                    const next = new Set(s);
                    if (!next.delete(kind)) next.add(kind);
                    return next;
                  })
                }
                type="checkbox"
              />
              <span class={`inline-block size-2.5 ${DOT[kind]}`} />
              {label} <span class="text-muted">{counts.get(kind) ?? 0}</span>
            </label>
          ))}
        </fieldset>
        <span class="inline-flex gap-1 sm:ml-auto">
          <button aria-label="Zoom out" class="min-w-10 font-semibold" onClick={() => zoom(0.5)} type="button">
            −
          </button>
          <button aria-label="Zoom in" class="min-w-10 font-semibold" onClick={() => zoom(2)} type="button">
            +
          </button>
        </span>
      </div>
      {data && !data.drawn && (
        <p class="text-muted">No client files here, so the map shows markers only (start the analyzer with --files).</p>
      )}
      {!data && <p class="text-muted">Loading…</p>}
      {data && (
        <div
          aria-label={`${data.name} map: drag to move, scroll or + and − to zoom, arrow keys to pan`}
          class="relative h-[calc(100vh-200px)] min-h-90 cursor-grab touch-none select-none overflow-hidden rounded-box border border-line bg-[#0b1a2a] active:cursor-grabbing"
          onKeyDown={(e) => {
            const step = 120;
            const keys: Record<string, () => void> = {
              ArrowLeft: () => pan(-step, 0),
              ArrowRight: () => pan(step, 0),
              ArrowUp: () => pan(0, -step),
              ArrowDown: () => pan(0, step),
              '+': () => zoom(2),
              '=': () => zoom(2),
              '-': () => zoom(0.5)
            };
            const act = keys[e.key];
            if (act) {
              e.preventDefault();
              act();
            }
          }}
          onPointerDown={(e) => {
            if (!view || (e.target as Element).closest('a')) return;
            drag.current = { x: e.clientX, y: e.clientY, view };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            setView({
              ...d.view,
              x: d.view.x - (e.clientX - d.x) / d.view.scale,
              y: d.view.y - (e.clientY - d.y) / d.view.scale
            });
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onWheel={(e) => {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            zoom(e.deltaY < 0 ? 1.25 : 0.8, { x: e.clientX - rect.left, y: e.clientY - rect.top });
          }}
          ref={box}
          role="application"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the map takes arrow keys and +/- once focused.
          tabIndex={0}
        >
          {tiles}
          {view &&
            markers.map((m, i) => (
              <a
                class={`absolute -mt-[5px] -ml-[5px] size-2.5 shadow-[0_0_0_1.5px_#fff,0_1px_3px_rgb(0_0_0/0.5)] hover:z-2 hover:scale-160 focus-visible:z-2 focus-visible:scale-160 ${DOT[m.kind]}`}
                href={m.href}
                key={i}
                style={at(m)}
                title={`${m.label} (${m.x}, ${m.y})`}
              >
                <span class="sr-only">{m.label}</span>
              </a>
            ))}
          {view && pin && inView(pin.x, pin.y) && (
            <span
              class="pointer-events-none absolute -mt-[11px] -ml-[11px] size-[22px] rounded-full border-3 border-white shadow-[0_0_0_2px_#000]"
              style={at(pin)}
            />
          )}
          {view && (
            <span class="absolute right-2 bottom-2 rounded-md bg-surface px-2 py-0.5 text-muted text-xs tabular-nums">
              {Math.round(view.x)}, {Math.round(view.y)} ·{' '}
              {view.scale >= 1 ? `${view.scale}×` : `1:${Math.round(1 / view.scale)}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
