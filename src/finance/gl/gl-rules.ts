import { Prisma } from '@prisma/client';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';

// ============================================================================
// The general ledger's rules (ADR 0092): double entry, beside ADR 0048's
// computed journal. Entries post by triggers on the money tables
// (20270615090200); what is here is what the reads and the manual entries
// decide.
// ============================================================================

export const GL_ACCOUNT_TYPES = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
] as const;
export type GlAccountType = (typeof GL_ACCOUNT_TYPES)[number];

/** An asset or an expense grows by its debits; the others by their credits. */
export const DEBIT_NORMAL: readonly GlAccountType[] = ['asset', 'expense'];

/** What an entry comes from: one event of the app's, or a manual entry. */
export const GL_SOURCES = [
  'invoice',
  'credit_note',
  'payment',
  'payment_reversal',
  'allocation',
  'allocation_release',
  'refund',
  'refund_reversal',
  'deposit',
  'deposit_event',
  'expense',
  'expense_void',
  'vendor_invoice',
  'vendor_invoice_cancel',
  'vendor_payout',
  'cash_movement',
  'custody_handin',
  'club_payment',
  'vehicle_fine_payment',
  'violation_payment',
  'manual',
  // Taxes and the year-end close (ADR 0093).
  'vat_declaration',
  'tax_payment',
  'year_close',
  'year_reopen',
] as const;
export type GlSource = (typeof GL_SOURCES)[number];

export const GL_MANUAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type GlManualStatus = (typeof GL_MANUAL_STATUSES)[number];

export const GL_LIMITS = {
  /** A manual entry's lines. */
  lines: { min: 2, max: 50 },
  memo: 500,
  lineMemo: 200,
  name: 100,
} as const;

/** A sub-account's code: its parent's, a dot, and one to three digits. */
export const GL_CODE = /^[0-9]{4}(\.[0-9]{1,3}){0,3}$/;
/** A positive amount below a billion, two decimals at most. */
export const GL_AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;
/** A month: `YYYY-MM`. */
export const GL_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type Money = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

/** The first day of a day's month. */
export const monthOf = (d: LocalDate): LocalDate => `${d.slice(0, 7)}-01`;

/** A month (`YYYY-MM` or its first day) as its first day. */
export const firstDay = (m: string): LocalDate => `${m.slice(0, 7)}-01`;

/** The first day of the month after. */
export function nextMonth(m: LocalDate): LocalDate {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
}

/** The last day of a day's month. */
export const lastDay = (d: LocalDate): LocalDate =>
  addDays(nextMonth(monthOf(d)), -1);

/** Every month's first day from `from` to `to`, both included. */
export function monthsBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = nextMonth(m)) out.push(m);
  return out;
}

/** An account's balance on its normal side: positive is its usual sign. */
export function normalBalance(
  type: GlAccountType,
  debit: Money,
  credit: Money,
): Money {
  return DEBIT_NORMAL.includes(type) ? debit.sub(credit) : credit.sub(debit);
}

/** A balance as one side of a trial balance. */
export function sideOf(
  debit: Money,
  credit: Money,
): { debit: Money; credit: Money } {
  const net = debit.sub(credit);
  return net.gte(ZERO)
    ? { debit: net, credit: ZERO }
    : { debit: ZERO, credit: net.neg() };
}

export interface GlNode {
  id: string;
  parentId: string | null;
  debit: Money;
  credit: Money;
}

/** Each account's totals with its sub-accounts', all the way down. */
export function rollUp<T extends GlNode>(
  accounts: readonly T[],
): Map<string, { debit: Money; credit: Money }> {
  const children = new Map<string, T[]>();
  for (const a of accounts) {
    if (!a.parentId) continue;
    children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);
  }
  const out = new Map<string, { debit: Money; credit: Money }>();
  const visit = (a: T): { debit: Money; credit: Money } => {
    const known = out.get(a.id);
    if (known) return known;
    let debit = a.debit;
    let credit = a.credit;
    for (const c of children.get(a.id) ?? []) {
      const t = visit(c);
      debit = debit.add(t.debit);
      credit = credit.add(t.credit);
    }
    const total = { debit, credit };
    out.set(a.id, total);
    return total;
  };
  accounts.forEach(visit);
  return out;
}

export interface GlLineInput {
  debit: Money;
  credit: Money;
}

/** A manual entry's totals; balanced when they are equal and not zero. */
export function totals(lines: readonly GlLineInput[]): {
  debit: Money;
  credit: Money;
  balanced: boolean;
} {
  const debit = lines.reduce((s, l) => s.add(l.debit), ZERO);
  const credit = lines.reduce((s, l) => s.add(l.credit), ZERO);
  return { debit, credit, balanced: debit.eq(credit) && debit.gt(ZERO) };
}

/** The months a close through `month` closes: the open ones, in order. */
export function monthsToClose(
  through: LocalDate,
  firstEntry: LocalDate | null,
  closed: ReadonlySet<LocalDate>,
): LocalDate[] {
  const start =
    firstEntry && monthOf(firstEntry) < through ? monthOf(firstEntry) : through;
  return monthsBetween(start, through).filter((m) => !closed.has(m));
}
