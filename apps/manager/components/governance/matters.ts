// The dashboard's side of the board's matters (ADR 0055): pure helpers, tested.

export const APPROVAL_TYPE_TEXT: Record<string, string> = {
  annual_budget: 'Annual budget',
  budget_increase: 'Budget increase',
  major_contract: 'Major contract',
  exceptional_fee: 'Exceptional fee',
  waiver_above_limit: 'Waiver above the limit',
  payment_plan_above_limit: 'Payment plan above the limit',
  legal_escalation: 'Legal escalation',
};

/** What each type of request names as its subject: the raise form asks for it. */
export const APPROVAL_SUBJECT: Record<string, 'budget' | 'budget_line' | null> = {
  annual_budget: 'budget',
  budget_increase: 'budget_line',
  major_contract: null,
  exceptional_fee: null,
  waiver_above_limit: null,
  payment_plan_above_limit: null,
  legal_escalation: null,
};

export const APPROVAL_STATUS_TEXT: Record<string, string> = {
  pending: 'Awaiting the board',
  approved: 'Approved',
  implemented: 'Implemented',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const APPEAL_KIND_TEXT: Record<string, string> = {
  vehicle_fine: 'Vehicle fine',
  unit_violation: 'Violation',
  booking_suspension: 'Booking suspension',
  invoice_dispute: 'Invoice dispute',
  // ADR 0059.
  management_appeal: 'Management decision appealed',
  management_complaint: 'Complaint about the management',
};

export const APPEAL_STATUS_TEXT: Record<string, string> = {
  pending: 'Awaiting the board',
  upheld: 'Upheld',
  overturned: 'Overturned',
  withdrawn: 'Withdrawn',
};

export const EFFECT_TEXT: Record<string, string> = {
  applied: 'Applied by the system',
  follow_up: 'For the management to follow up',
  none: 'Nothing to change',
};

export const MOTION_OUTCOME_TEXT: Record<string, string> = {
  approve: 'Approve',
  reject: 'Reject',
  uphold: 'Uphold the decision',
  overturn: 'Overturn the decision',
};

export const MOTION_STATUS_TEXT: Record<string, string> = {
  open: 'Open',
  carried: 'Carried',
  failed: 'Failed',
  withdrawn: 'Withdrawn',
  lapsed: 'Lapsed: its board no longer sits',
};

/** As the board's announcement names them (the backend's CATEGORY_LABELS). */
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

export const BUDGET_STATUS_TEXT: Record<string, string> = {
  draft: 'Draft',
  submitted: 'With the board',
  active: 'Active',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/** "2 for · 1 against · 3 of 5 seats voted, quorum 3". */
export function tallyText(t: { seats: number; quorum: number; for: number; against: number }): string {
  const cast = t.for + t.against;
  return `${t.for} for · ${t.against} against · ${cast} of ${t.seats} seats voted, quorum ${t.quorum}`;
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

/** "appealDecision" → "Appeal decision"; nested keys joined with " · ". */
function labelOf(path: string[]): string {
  return path
    .map((k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase())
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
export function subjectParts(subject: unknown): { rows: SubjectRow[]; tables: SubjectTable[] } {
  const rows: SubjectRow[] = [];
  const tables: SubjectTable[] = [];
  const walk = (value: unknown, path: string[]) => {
    const key = path[path.length - 1] ?? '';
    if (/Id$|^id$/.test(key)) return;
    if (scalar(value)) {
      if (path.length) rows.push({ label: labelOf(path), value });
      return;
    }
    if (Array.isArray(value)) {
      const objects = value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v));
      if (objects.length !== value.length) {
        rows.push({ label: labelOf(path), value: value.map(String).join(', ') });
        return;
      }
      const columns = [...new Set(objects.flatMap((o) => Object.keys(o)))].filter((c) => !/Id$|^id$/.test(c));
      tables.push({
        label: labelOf(path),
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
export function columnLabel(key: string): string {
  return labelOf([key]);
}

// ---------------------------------------------------------------------------
// The owners' voice, the board's side (ADR 0059)
// ---------------------------------------------------------------------------

export const REPRESENTATIVE_ACTION_TEXT: Record<string, string> = {
  appoint: 'Name a representative',
  end: 'End a term',
};

export const REPRESENTATIVE_MATTER_STATUS_TEXT: Record<string, string> = {
  pending: 'Awaiting the board',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const REPRESENTATIVE_END_TEXT: Record<string, string> = {
  ended: 'Ended by the board',
  replaced: 'Replaced by the next',
  no_longer_owner: 'No longer owns a unit there',
  account_closed: 'Account closed',
};

const NOT_APPLIED_TEXT: Record<string, string> = {
  not_an_owner: 'they no longer own a unit in the building',
  already_sitting: 'they were the representative already',
  already_ended: 'the term had ended already',
};

/** What became of a matter the board decided: applied, rejected, or why an approval changed nothing. */
export function matterOutcomeText(d: { decision: string; effect: string | null; effectReason: string | null }): string {
  if (d.decision !== 'approved') return 'Rejected: nothing changed';
  if (d.effect === 'applied') return 'Approved and applied';
  return `Approved, not applied: ${d.effectReason ? (NOT_APPLIED_TEXT[d.effectReason] ?? d.effectReason) : 'unknown'}`;
}

export const AGENDA_STATUS_TEXT: Record<string, string> = {
  open: 'Awaiting the board',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn by the owner',
};

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
