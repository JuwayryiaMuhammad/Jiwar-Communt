/**
 * The general ledger's words and sums on the dashboard (ADR 0092). Plain
 * TypeScript, no imports: amounts are decimal strings, summed in piastres.
 */

/** A decimal string in piastres; null when it is not an amount. */
export function piastres(v: string): number | null {
  const s = v.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

const show = (p: number) => `${p < 0 ? '-' : ''}${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`;

export interface DraftLine {
  accountId: string;
  side: 'debit' | 'credit';
  amount: string;
}

/** A draft entry's totals; ready when every line is whole and the two sides agree. */
export function draftTotals(lines: readonly DraftLine[]): { debit: string; credit: string; ready: boolean } {
  let debit = 0;
  let credit = 0;
  let whole = lines.length >= 2;
  for (const l of lines) {
    const p = piastres(l.amount);
    if (p === null || p === 0 || !l.accountId) whole = false;
    else if (l.side === 'debit') debit += p;
    else credit += p;
  }
  return { debit: show(debit), credit: show(credit), ready: whole && debit === credit && debit > 0 };
}

/** The months that have ended, newest first, as `YYYY-MM`: what may be closed. */
export function endedMonths(today: string, count: number): string[] {
  const [y = 1970, m = 1] = today.split('-').map(Number);
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const k = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

const KEYS: Record<string, string> = {
  receivables: 'Receivables',
  unit_credit: 'Unit credit',
  deposits_held: 'Deposits held',
  payables: 'Payables',
  retentions: 'Retentions',
  vendor_advances: 'Vendor advances',
  cash_account: 'Bank or cash account',
};

/** What a reconciliation line checks. */
export const reconciliationLabel = (key: string) => KEYS[key] ?? key;
