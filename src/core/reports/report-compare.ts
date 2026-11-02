import { Prisma } from '@prisma/client';
import type { ReportComparison } from './report-periods';
import type {
  ReportColumn,
  ReportPeriod,
  ReportTable,
} from './report-registry';

/** One row: its cells, and the same row's cells in the compared periods. */
export interface ReportRow {
  values: (string | null)[];
  /** The period before; null when not compared. */
  previous: (string | null)[] | null;
  /** The same period a year earlier; null when not compared. */
  lastYear: (string | null)[] | null;
}

/** A report as read (ADR 0086): what the screen and every file draw. */
export interface ReportResult {
  key: string;
  title: { en: string; ar: string };
  groupBy: string;
  compare: ReportComparison;
  period: ReportPeriod;
  previousPeriod: ReportPeriod | null;
  lastYearPeriod: ReportPeriod | null;
  columns: ReportColumn[];
  /** The leading columns that name a row. */
  dimensions: number;
  rows: ReportRow[];
  /** The summed columns' totals, null elsewhere; the same for each compared period. */
  totals: ReportRow;
}

const ZERO = new Prisma.Decimal(0);

/** A row's key: its dimension cells. */
const keyOf = (row: (string | null)[], dimensions: number) =>
  JSON.stringify(row.slice(0, dimensions));

/**
 * The rows of a period lined up with those of the compared periods (ADR
 * 0086): matched on their dimensions, in the current period's order, then
 * the rows only an earlier period had. A summed figure a period has no row
 * for is 0 there; any other figure is null.
 */
export function lineUp(
  columns: readonly ReportColumn[],
  dimensions: number,
  current: ReportTable,
  previous: ReportTable | null,
  lastYear: ReportTable | null,
): { rows: ReportRow[]; totals: ReportRow } {
  const absent = (dims: (string | null)[]) =>
    columns.map((c, i) =>
      i < dimensions ? dims[i] : c.sum && c.kind !== 'text' ? '0' : null,
    );
  const index = (t: ReportTable | null) =>
    t ? new Map(t.rows.map((r) => [keyOf(r, dimensions), r])) : null;
  const prev = index(previous);
  const year = index(lastYear);
  const keys: string[] = [];
  const dims = new Map<string, (string | null)[]>();
  for (const t of [current, previous, lastYear])
    for (const r of t?.rows ?? []) {
      const k = keyOf(r, dimensions);
      if (!dims.has(k)) {
        keys.push(k);
        dims.set(k, r.slice(0, dimensions));
      }
    }
  const cur = index(current)!;
  const rows = keys.map((k) => ({
    values: cur.get(k) ?? absent(dims.get(k)!),
    previous: prev ? (prev.get(k) ?? absent(dims.get(k)!)) : null,
    lastYear: year ? (year.get(k) ?? absent(dims.get(k)!)) : null,
  }));
  const total = (pick: (r: ReportRow) => (string | null)[] | null) =>
    columns.map((c, i) => {
      if (i === 0) return 'Total';
      if (i < dimensions || !c.sum || c.kind === 'text') return null;
      return rows
        .reduce((s, r) => s.plus(pick(r)?.[i] ?? 0), ZERO)
        .toFixed(c.kind === 'money' ? 2 : decimalsOf(rows, i, pick));
    });
  return {
    rows,
    totals: {
      values: total((r) => r.values),
      previous: previous ? total((r) => r.previous) : null,
      lastYear: lastYear ? total((r) => r.lastYear) : null,
    },
  };
}

/** The most decimals a column's cells show, so a total reads like them. */
function decimalsOf(
  rows: readonly ReportRow[],
  i: number,
  pick: (r: ReportRow) => (string | null)[] | null,
): number {
  let most = 0;
  for (const r of rows) {
    const v = pick(r)?.[i];
    const dot = v ? v.indexOf('.') : -1;
    if (v && dot >= 0) most = Math.max(most, v.length - dot - 1);
  }
  return most;
}

/**
 * The change from `before` to `now` as a percentage to one decimal, or null
 * when either is unknown or `before` is 0 (no base to change from).
 */
export function changePercent(
  now: string | null,
  before: string | null,
): string | null {
  if (now === null || before === null) return null;
  const b = new Prisma.Decimal(before);
  if (b.isZero()) return null;
  return new Prisma.Decimal(now)
    .minus(b)
    .dividedBy(b.abs())
    .times(100)
    .toFixed(1);
}

/** A flat sheet of a result, for a file: header, kinds, rows. */
export interface ReportSheet {
  headers: { en: string; ar: string }[];
  kinds: ('text' | 'number')[];
  rows: (string | null)[][];
}

/**
 * A result as one flat table (ADR 0086): its columns, and for each figure
 * compared, the period before and the change, the same period a year
 * earlier and the change, then the totals' row.
 */
export function flatten(r: ReportResult): ReportSheet {
  const headers: ReportSheet['headers'] = [];
  const kinds: ReportSheet['kinds'] = [];
  r.columns.forEach((c, i) => {
    headers.push({ en: c.en, ar: c.ar });
    kinds.push(c.kind === 'text' ? 'text' : 'number');
    if (i < r.dimensions || c.kind === 'text') return;
    if (r.previousPeriod) {
      headers.push(
        { en: `${c.en} (period before)`, ar: `${c.ar} (الفترة السابقة)` },
        { en: `${c.en} change %`, ar: `${c.ar} التغير %` },
      );
      kinds.push('number', 'number');
    }
    if (r.lastYearPeriod) {
      headers.push(
        { en: `${c.en} (a year earlier)`, ar: `${c.ar} (العام السابق)` },
        { en: `${c.en} change % on the year`, ar: `${c.ar} التغير السنوي %` },
      );
      kinds.push('number', 'number');
    }
  });
  const flat = (row: ReportRow) =>
    r.columns.flatMap((c, i) => {
      const v = row.values[i];
      if (i < r.dimensions || c.kind === 'text') return [v];
      const out = [v];
      if (r.previousPeriod) {
        const p = row.previous?.[i] ?? null;
        out.push(p, changePercent(v, p));
      }
      if (r.lastYearPeriod) {
        const y = row.lastYear?.[i] ?? null;
        out.push(y, changePercent(v, y));
      }
      return out;
    });
  return {
    headers,
    kinds,
    rows: [...r.rows.map(flat), flat(r.totals)],
  };
}
