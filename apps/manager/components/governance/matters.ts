// The dashboard's side of the board's matters (ADR 0055): pure helpers, tested.
// The words come from the gov-codes catalog (`approvalType.<code>`,
// `motionStatus.<code>`…) through the `t` a caller hands in.
import type { GovT } from './logic.ts';

/** What each type of request names as its subject: the raise form asks for it. */
export const APPROVAL_SUBJECT: Record<string, 'budget' | 'budget_line' | 'manager' | 'budget_transfer' | 'capital_plan' | null> = {
  annual_budget: 'budget',
  budget_increase: 'budget_line',
  major_contract: null,
  exceptional_fee: null,
  waiver_above_limit: null,
  payment_plan_above_limit: null,
  legal_escalation: null,
  manager_handover_override: 'manager',
  budget_transfer: 'budget_transfer',
  // ADR 0086: raised from the capital plan's own page.
  capital_plan: 'capital_plan',
};

/** Every type of request, in the order the raise form lists them. */
export const APPROVAL_TYPES = Object.keys(APPROVAL_SUBJECT);

/**
 * As the board's announcement names them (the backend's CATEGORY_LABELS).
 * English only: the finance pages still read it; governance's own pages
 * use the catalog's `category.<code>`.
 */
export const CATEGORY_TEXT: Record<string, string> = {
  security: 'Security',
  cleaning: 'Cleaning',
  landscaping: 'Landscaping',
  maintenance: 'Maintenance',
  utilities: 'Utilities',
  staff: 'Staff',
  insurance: 'Insurance',
  administration: 'Administration',
  reserve_fund: 'Reserve fund',
  other: 'Other',
};
export const BUDGET_CATEGORIES = Object.keys(CATEGORY_TEXT);

/** English only, for the finance pages that still read it. */
export const BUDGET_STATUS_TEXT: Record<string, string> = {
  draft: 'Draft',
  submitted: 'With the board',
  active: 'Active',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/** "2 for · 1 against · 3 of 5 seats voted, quorum 3". */
export function tallyText(t: GovT, x: { seats: number; quorum: number; for: number; against: number }): string {
  return t('tally', { for: x.for, against: x.against, cast: x.for + x.against, seats: x.seats, quorum: x.quorum });
}

export type SubjectValue = string | number | boolean | null;
export interface SubjectRow {
  label: string;
  value: SubjectValue;
}
export interface SubjectTable {
  label: string;
  columns: string[];
  rows: Record<string, SubjectValue>[];
}

/** The words for one key of a subject, given as a snake_case code (`fiscal_year`). */
export type KeyName = (code: string) => string;

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * "appealDecision" → "Appeal decision"; nested keys joined with " · ". With
 * `name`, each key is named by it (a page's language) instead.
 */
function labelOf(path: string[], name?: KeyName): string {
  if (name) return path.map((k) => name(snake(k))).join(' · ');
  return path
    .map((k) => snake(k).replace(/_/g, ' '))
    .join(' · ')
    .replace(/^./, (c) => c.toUpperCase());
}

function scalar(v: unknown): v is SubjectValue {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * A matter's subject as its domain described it (codes, amounts, dates; no
 * names): the scalars as rows, nested objects flattened into them, lists of
 * objects as tables. Ids are left out: they mean nothing to a reader.
 */
export function subjectParts(subject: unknown, name?: KeyName): { rows: SubjectRow[]; tables: SubjectTable[] } {
  const rows: SubjectRow[] = [];
  const tables: SubjectTable[] = [];
  const walk = (value: unknown, path: string[]) => {
    const key = path[path.length - 1] ?? '';
    if (/Id$|^id$/.test(key)) return;
    if (scalar(value)) {
      if (path.length) rows.push({ label: labelOf(path, name), value });
      return;
    }
    if (Array.isArray(value)) {
      const objects = value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v));
      if (objects.length !== value.length) {
        rows.push({ label: labelOf(path, name), value: value.map(String).join(', ') });
        return;
      }
      const columns = [...new Set(objects.flatMap((o) => Object.keys(o)))].filter((c) => !/Id$|^id$/.test(c));
      tables.push({
        label: labelOf(path, name),
        columns,
        rows: objects.map((o) =>
          Object.fromEntries(columns.map((c) => [c, o[c] === undefined ? null : scalar(o[c]) ? o[c] : JSON.stringify(o[c])])),
        ),
      });
      return;
    }
    if (typeof value === 'object' && value !== null)
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
  };
  walk(subject, []);
  return { rows, tables };
}

/** A column's header, as a row's label would read. */
export function columnLabel(key: string, name?: KeyName): string {
  return labelOf([key], name);
}

// ---------------------------------------------------------------------------
// The owners' voice, the board's side (ADR 0059)
// ---------------------------------------------------------------------------

/** What became of a matter the board decided: applied, rejected, or why an approval changed nothing. */
export function matterOutcomeText(t: GovT, d: { decision: string; effect: string | null; effectReason: string | null }): string {
  if (d.decision !== 'approved') return t('matter.rejected');
  if (d.effect === 'applied') return t('matter.applied');
  return t('matter.notApplied', { reason: d.effectReason ?? '' });
}

/**
 * Where a decision stands for objections at `now` (the database's clock
 * the page read): answered (no more), open until its day, or closed;
 * null for minutes or an archived decision.
 */
export function objectionState(
  o: { until: string; answered: boolean } | null,
  now: Date,
): 'answered' | 'open' | 'closed' | null {
  if (!o) return null;
  if (o.answered) return 'answered';
  return new Date(o.until) > now ? 'open' : 'closed';
}
