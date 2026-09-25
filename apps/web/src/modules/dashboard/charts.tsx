/**
 * Accessible chart primitives (recharts). Palette: validated categorical slots 1–3 (blue, orange, aqua) and
 * the fixed status palette — see docs/DASHBOARDS-REPORTS-ALERTS.md §Charts. Every chart has a text summary
 * (aria-label + visible caption) and a data-table view, so identity/values never rely on colour alone.
 */
import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'] as const;
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', info: '#2a78d6' } as const;
const GRID = '#e5e4e0';
const AXIS = { fontSize: 11, fill: '#52514e' };

export interface SeriesDef<T> {
  key: keyof T & string;
  label: string;
  format?: (v: number) => string;
}

function DataTableView<T extends Record<string, unknown>>({ rows, x, xLabel, series }: { rows: T[]; x: keyof T & string; xLabel: string; series: Array<SeriesDef<T>> }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-ink-600 hover:text-ink-900">Show data table</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="min-w-full text-left">
          <thead>
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium text-ink-600">{xLabel}</th>
              {series.map((s) => <th key={s.key} scope="col" className="py-1 pr-3 text-right font-medium text-ink-600">{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-ink-100">
                <th scope="row" className="py-1 pr-3 font-normal text-ink-800">{String(r[x])}</th>
                {series.map((s) => <td key={s.key} className="py-1 pr-3 text-right tabular-nums text-ink-800">{(s.format ?? String)(Number(r[s.key] ?? 0))}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ChartFigure({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <figure aria-label={`${title}. ${summary}`} className="m-0">
      <figcaption className="mb-2 text-xs text-ink-600">{summary}</figcaption>
      {children}
    </figure>
  );
}

/** Vertical bars over time (1–3 series, grouped). One y-axis only. */
export function TimeBars<T extends Record<string, unknown>>({ title, rows, x, series, summary, height = 220, yFormat }: {
  title: string; rows: T[]; x: keyof T & string; series: Array<SeriesDef<T>>; summary: string; height?: number; yFormat?: (v: number) => string;
}) {
  return (
    <ChartFigure title={title} summary={summary}>
      <div role="img" aria-label={`${title} bar chart. ${summary}`} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey={x as never} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(v: string) => String(v).slice(5)} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} allowDecimals={false} tickFormatter={yFormat} />
            <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v: unknown, name: unknown) => {
              const s = series.find((d) => d.label === name);
              return [(s?.format ?? String)(Number(v)), String(name)];
            }} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} iconType="square" />}
            {series.map((s, i) => <Bar key={s.key} dataKey={s.key as never} name={s.label} fill={SERIES[i % SERIES.length]} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <DataTableView rows={rows} x={x} xLabel="Day" series={series} />
    </ChartFigure>
  );
}

/** Horizontal bars for a categorical breakdown; optional per-row colour (status) with text labels. */
export function CategoryBars<T extends Record<string, unknown>>({ title, rows, label, value, summary, format, colorOf, height }: {
  title: string; rows: T[]; label: keyof T & string; value: keyof T & string; summary: string; format?: (v: number) => string; colorOf?: (r: T) => string; height?: number;
}) {
  const h = height ?? Math.max(90, rows.length * 30 + 20);
  return (
    <ChartFigure title={title} summary={summary}>
      <div role="img" aria-label={`${title} bar chart. ${summary}`} style={{ height: h }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={format} />
            <YAxis type="category" dataKey={label as never} tick={AXIS} tickLine={false} axisLine={false} width={120} />
            <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v: unknown) => [(format ?? String)(Number(v)), title]} />
            <Bar dataKey={value as never} fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}
              label={{ position: 'right', fontSize: 11, fill: '#0b0b0b', formatter: (v: unknown) => (format ?? String)(Number(v)) }}>
              {colorOf && rows.map((r, i) => <Cell key={i} fill={colorOf(r)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <DataTableView rows={rows} x={label} xLabel="Category" series={[{ key: value, label: 'Value', format }]} />
    </ChartFigure>
  );
}

/** Utilisation meter with warning/critical threshold markers (text + marker, not colour alone). */
export function ThresholdMeter({ percent, warn, critical, label }: { percent: number | null; warn: number; critical: number; label: string }) {
  if (percent === null) return <p className="text-sm text-ink-600">Capacity not declared — set storagePolicy.capacityBytes in settings to track utilisation.</p>;
  const level = percent >= critical ? 'Critical' : percent >= warn ? 'Warning' : 'Normal';
  const color = percent >= critical ? STATUS.critical : percent >= warn ? STATUS.warning : STATUS.good;
  const p = Math.min(100, Math.max(0, percent));
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-700">{label}</span>
        <span className="font-semibold text-ink-900">{percent.toFixed(1)}% · {level}</span>
      </div>
      <div className="relative mt-2 h-3 rounded-full bg-ink-100" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={`${label}: ${percent.toFixed(1)}% used, ${level}. Warning at ${warn}%, critical at ${critical}%.`}>
        <div className="h-3 rounded-full" style={{ width: `${p}%`, background: color }} />
        {[warn, critical].map((t) => <div key={t} className="absolute -top-1 h-5 w-0.5 bg-ink-800" style={{ left: `${t}%` }} aria-hidden />)}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-ink-600" aria-hidden>
        <span className="absolute -translate-x-1/2" style={{ left: `${warn}%` }}>warn {warn}%</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${critical}%` }}>crit {critical}%</span>
      </div>
    </div>
  );
}
