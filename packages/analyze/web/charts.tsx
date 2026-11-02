import { useEffect, useRef, useState } from 'preact/hooks';

import type { Block } from '../src/doc';

// The overview's pieces (src/overview.ts): headline numbers, a measure over time with a hover
// readout, how a whole splits into parts, and a small map of where residents are.
type Of<K extends Block['kind']> = Extract<Block, { kind: K }>;

const number = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 1 });
const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const TONE = { good: 'text-good', error: 'text-error', muted: 'text-muted' } as const;

export function Stats({ block }: { block: Of<'stats'> }) {
  return (
    <div class="my-4 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
      {block.items.map((s) => {
        const body = (
          <>
            <span class="text-muted text-sm">{s.label}</span>
            <span class="font-semibold text-2xl text-fg tabular-nums tracking-tight">{s.value}</span>
            {s.delta && <span class={`text-sm ${TONE[s.delta.tone]}`}>{s.delta.text}</span>}
            {s.note && <span class="text-muted text-xs">{s.note}</span>}
          </>
        );
        const box = 'flex flex-col gap-0.5 rounded-box border border-line bg-surface p-3.5';
        return s.href ? (
          <a class={`${box} no-underline hover:border-muted`} href={s.href} key={s.label}>
            {body}
          </a>
        ) : (
          <div class={box} key={s.label}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// Round steps for the value axis: 1, 2 or 5 times a power of ten.
function ticks(min: number, max: number) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const list: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step) list.push(v);
  return list;
}

export function LineChart({ block }: { block: Of<'line'> }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number>();
  const points = block.points;
  if (points.length < 2) return <p class="text-muted">Not enough samples yet.</p>;
  const height = 180;
  const pad = { left: 56, right: 12, top: 12, bottom: 24 };
  const t0 = points[0]?.[0] ?? 0;
  const t1 = points.at(-1)?.[0] ?? 1;
  const values = points.map((p) => p[1]);
  const axis = ticks(Math.min(...values), Math.max(...values));
  const lo = axis[0] ?? 0;
  const hi = axis.at(-1) ?? 1;
  const x = (t: number) => pad.left + ((t - t0) / (t1 - t0 || 1)) * (width - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo || 1)) * (height - pad.top - pad.bottom);
  const path = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const hours = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
  const shown = hover === undefined ? undefined : points[hover];
  return (
    <figure class="mx-0 my-3 rounded-box border border-line bg-surface p-3">
      <figcaption class="mb-1 font-semibold text-sm">{block.label}</figcaption>
      <div class="relative" ref={ref}>
        {width > 0 && (
          <svg
            aria-label={`${block.label}: from ${number(values[0] ?? 0)} to ${number(values.at(-1) ?? 0)}`}
            class="block touch-none"
            height={height}
            onPointerLeave={() => setHover(undefined)}
            onPointerMove={(e) => {
              const left = e.currentTarget.getBoundingClientRect().left;
              const at = t0 + ((e.clientX - left - pad.left) / (width - pad.left - pad.right)) * (t1 - t0);
              let best = 0;
              for (let i = 1; i < points.length; i++)
                if (Math.abs((points[i]?.[0] ?? 0) - at) < Math.abs((points[best]?.[0] ?? 0) - at)) best = i;
              setHover(best);
            }}
            role="img"
            width={width}
          >
            {axis.map((v) => (
              <g key={v}>
                <line class="stroke-line" x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} />
                <text class="fill-muted text-[11px] tabular-nums" text-anchor="end" x={pad.left - 8} y={y(v) + 4}>
                  {number(v)}
                </text>
              </g>
            ))}
            {hours.map((t, i) => (
              <text
                class="fill-muted text-[11px]"
                key={t}
                text-anchor={i === 0 ? 'start' : i === hours.length - 1 ? 'end' : 'middle'}
                x={x(t)}
                y={height - 6}
              >
                {clock(t)}
              </text>
            ))}
            {(block.marks ?? []).map((m) => (
              <line
                class="stroke-error"
                key={m.at}
                stroke-dasharray="3 3"
                x1={x(m.at)}
                x2={x(m.at)}
                y1={pad.top}
                y2={height - pad.bottom}
              >
                <title>{`${m.label} at ${clock(m.at)}`}</title>
              </line>
            ))}
            <path class="stroke-series-1" d={path} fill="none" stroke-linejoin="round" stroke-width="2" />
            {shown && (
              <g>
                <line class="stroke-muted" x1={x(shown[0])} x2={x(shown[0])} y1={pad.top} y2={height - pad.bottom} />
                <circle class="fill-series-1 stroke-surface" cx={x(shown[0])} cy={y(shown[1])} r="4" stroke-width="2" />
              </g>
            )}
          </svg>
        )}
        {shown && (
          <div
            class="pointer-events-none absolute top-1 rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-sm"
            style={{ left: `${Math.min(x(shown[0]) + 8, width - 140)}px` }}
          >
            <div class="text-muted">{clock(shown[0])}</div>
            <div class="font-semibold tabular-nums">{number(shown[1])}</div>
          </div>
        )}
      </div>
      {(block.marks?.length ?? 0) > 0 && (
        <p class="mt-1 mb-0 text-muted text-xs">
          <span class="text-error">┆</span> {block.marks?.length} stall{block.marks?.length === 1 ? '' : 's'}
        </p>
      )}
    </figure>
  );
}

// Fixed slots by position (the server sends parts in a fixed order).
const SLOTS = ['bg-series-1', 'bg-series-2', 'bg-series-3', 'bg-series-4', 'bg-series-5', 'bg-muted'];

export function Shares({ block }: { block: Of<'shares'> }) {
  const total = block.parts.reduce((n, p) => n + p.value, 0) || 1;
  const parts = block.parts.map((p, i) => ({ ...p, slot: SLOTS[i] ?? 'bg-muted', share: p.value / total }));
  return (
    <figure class="mx-0 my-3 rounded-box border border-line bg-surface p-3">
      <figcaption class="mb-2 font-semibold text-sm">{block.label}</figcaption>
      <div class="flex h-4 gap-0.5 overflow-hidden rounded">
        {parts
          .filter((p) => p.share > 0)
          .map((p) => (
            <span
              class={`${p.slot} h-full first:rounded-l last:rounded-r`}
              key={p.label}
              style={{ width: `${p.share * 100}%` }}
              title={`${p.label}: ${Math.round(p.share * 100)}%`}
            />
          ))}
      </div>
      <ul class="mt-2 mb-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm">
        {parts.map((p) => (
          <li class="inline-flex items-center gap-1.5" key={p.label}>
            <span class={`inline-block size-2.5 rounded-sm ${p.slot}`} />
            {p.label} <span class="text-muted tabular-nums">{Math.round(p.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

// The resident facet at 1:16 (the server's map tiles at level 4), dots for who is online.
export function MiniMap({ block }: { block: Of<'minimap'> }) {
  const [ref, width] = useWidth();
  const level = 4;
  const span = 256 << level;
  const scale = width / block.width;
  const tiles = [];
  if (block.drawn && width)
    for (let ty = 0; ty * span < block.height; ty++)
      for (let tx = 0; tx * span < block.width; tx++)
        tiles.push(
          <img
            alt=""
            class="absolute [image-rendering:pixelated]"
            key={`${tx}:${ty}`}
            src={`/maptile/${block.map}/${level}/${tx}/${ty}`}
            style={{
              left: `${tx * span * scale}px`,
              top: `${ty * span * scale}px`,
              width: `${span * scale}px`,
              height: `${span * scale}px`
            }}
          />
        );
  return (
    <figure class="mx-0 my-3">
      <div
        class="relative overflow-hidden rounded-box border border-line bg-[#0b1a2a]"
        ref={ref}
        style={{ aspectRatio: `${block.width} / ${block.height}` }}
      >
        {tiles}
        {width > 0 &&
          block.dots.map((d) => (
            <a
              class="absolute -mt-1 -ml-1 size-2 rounded-full bg-resident shadow-[0_0_0_1.5px_#fff] hover:scale-150"
              href={d.href}
              key={d.href}
              style={{ left: `${d.x * scale}px`, top: `${d.y * scale}px` }}
              title={d.label}
            >
              <span class="sr-only">{d.label}</span>
            </a>
          ))}
      </div>
      <figcaption class="mt-1 text-muted text-sm">
        {block.dots.length} residents online here · <a href={`/map?m=${block.map}`}>open the full map</a>
      </figcaption>
    </figure>
  );
}
