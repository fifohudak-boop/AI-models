// Small hand-made SVG charts (no chart library): thin marks, hairline grid,
// a tooltip on hover and keyboard focus, and a table view next to each chart
// so no number is only reachable by hovering.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// A clean top for the axis: 1, 2, 2.5 or 5 × 10ⁿ.
function niceMax(value: number) {
  if (!(value > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (value <= m * pow) return m * pow;
  return 10 * pow;
}

// Column with a 4px rounded top and a square foot on the baseline.
function columnPath(x: number, top: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  const bottom = top + h;
  return `M${x},${bottom}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${top + r}V${bottom}Z`;
}

function Tooltip({ left, top, value, lines }: { left: number; top: number; value: string; lines: string[] }) {
  return (
    <div className="chart-tooltip" style={{ left, top }} role="status">
      <strong>{value}</strong>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

export interface Column {
  key: string;
  label: string; // axis label
  value: number;
  lines: string[]; // tooltip lines under the value
}

const PAD = { top: 12, right: 6, bottom: 26, left: 46 };

export function ColumnChart({
  data,
  format,
  tickFormat = format,
  ariaLabel,
  labelEvery = 1,
  height = 190,
}: {
  data: Column[];
  format: (n: number) => string;
  tickFormat?: (n: number) => string;
  ariaLabel: string;
  labelEvery?: number;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(1, Math.min(24, band - 2)); // ≤ 24px, 2px surface gap
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const shown = active !== null ? data[active] : null;
  // Axis labels at least ~48px apart, so they never collide on a phone.
  // Stays a multiple of labelEvery (every 3 h → every 6 h, never every 5 h).
  const every = labelEvery * Math.max(1, Math.ceil((band > 0 ? Math.ceil(48 / band) : 1) / labelEvery));

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    setActive((i) => Math.min(data.length - 1, Math.max(0, (i ?? (step > 0 ? -1 : data.length)) + step)));
  };

  return (
    <div
      className="chart"
      ref={ref}
      style={{ height }}
      tabIndex={0}
      aria-label={`${ariaLabel}. Use the arrow keys to read each value.`}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart-tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {tickFormat(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = PAD.left + i * band + (band - barW) / 2;
            const h = (d.value / max) * plotH;
            return (
              <g key={d.key} onPointerEnter={() => setActive(i)}>
                <rect x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} fill="transparent" />
                {h > 0.5 && <path className={`chart-bar${active === i ? ' active' : ''}`} d={columnPath(x, y(d.value), barW, h)} />}
              </g>
            );
          })}
          {data.map((d, i) =>
            i % every === 0 ? (
              <text key={d.key} className="chart-tick" x={PAD.left + i * band + band / 2} y={height - 8} textAnchor="middle">
                {d.label}
              </text>
            ) : null
          )}
        </svg>
      )}
      {shown && active !== null && (
        <Tooltip
          left={Math.min(Math.max(PAD.left + active * band + band / 2, 70), width - 70)}
          top={y(shown.value) - 8}
          value={format(shown.value)}
          lines={shown.lines}
        />
      )}
    </div>
  );
}

export interface LinePoint {
  key: string;
  t: number; // ms
  label: string;
  value: number;
  lines: string[];
}

// One series over time, with a crosshair that snaps to the nearest point.
export function LineChart({
  points,
  format,
  tickFormat = format,
  ariaLabel,
  height = 170,
}: {
  points: LinePoint[];
  format: (n: number) => string;
  tickFormat?: (n: number) => string;
  ariaLabel: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - PAD.right - 8);
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? 1;
  const x = (t: number) => PAD.left + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.value)}`).join('');
  const last = points[points.length - 1];
  const shown = active !== null ? points[active] : null;

  const nearest = (clientX: number, el: Element) => {
    const px = clientX - el.getBoundingClientRect().left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.t) - px) < Math.abs(x(points[best].t) - px)) best = i;
    });
    return best;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? (step > 0 ? -1 : points.length)) + step)));
  };

  return (
    <div
      className="chart"
      ref={ref}
      style={{ height }}
      tabIndex={0}
      aria-label={`${ariaLabel}. Use the arrow keys to read each value.`}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      onPointerMove={(e) => points.length && setActive(nearest(e.clientX, e.currentTarget))}
      onPointerLeave={() => setActive(null)}
    >
      {width > 0 && points.length > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="chart-tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {tickFormat(t)}
              </text>
            </g>
          ))}
          {shown && <line className="chart-crosshair" x1={x(shown.t)} x2={x(shown.t)} y1={PAD.top} y2={PAD.top + plotH} />}
          <path className="chart-line" d={path} />
          {points.length > 1 && <path className="chart-area" d={`${path}L${x(last.t)},${y(0)}L${x(t0)},${y(0)}Z`} />}
          <circle className="chart-dot" cx={x((shown ?? last).t)} cy={y((shown ?? last).value)} r={4} />
          <text className="chart-tick" x={x(t0)} y={height - 8} textAnchor="start">
            {points[0].label}
          </text>
          {points.length > 1 && (
            <text className="chart-tick" x={x(last.t)} y={height - 8} textAnchor="end">
              {last.label}
            </text>
          )}
        </svg>
      )}
      {shown && (
        <Tooltip
          left={Math.min(Math.max(x(shown.t), 70), width - 70)}
          top={y(shown.value) - 10}
          value={format(shown.value)}
          lines={shown.lines}
        />
      )}
    </div>
  );
}

// A tiny trend line for stat tiles: the history in a quiet gray, the latest
// value as an accent dot.
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 76;
  const h = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const px = (i: number) => 3 + (i / (values.length - 1)) * (w - 6);
  const py = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${px(i)},${py(v)}`).join('');
  return (
    <svg className="sparkline" width={w} height={h} role="img" aria-label={label}>
      <path d={d} />
      <circle cx={px(values.length - 1)} cy={py(values[values.length - 1])} r={3} />
    </svg>
  );
}

// The same numbers as a table, for screen readers and anyone who prefers it.
export function TableView({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="chart-table">
      <summary>Show as table</summary>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
