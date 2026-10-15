/**
 * The finance screens' rules (ADR 0046). Plain TypeScript with no imports,
 * so the tests run it as is.
 */

export const KIND_TEXT: Record<string, string> = {
  service_charge: 'Service charge',
  maintenance: 'Maintenance',
  other: 'Other',
};

export const FREQUENCY_TEXT: Record<string, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

export const METHOD_TEXT: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  wallet: 'Mobile wallet',
};

export const OUTCOME_TEXT: Record<string, string> = {
  applied: 'Paid',
  duplicate: 'Repeated callback (ignored)',
  failed_attempt: 'Failed attempt',
  not_final: 'Not final yet',
  verification_pending: 'Waiting for Paymob to confirm',
  contradicted: 'Paymob contradicted it',
  order_mismatch: 'Another checkout’s order',
  amount_mismatch: 'Wrong amount',
  unknown_reference: 'Unknown checkout',
};

/** Outcomes the manager should look at. */
export const ALARMING = new Set(['contradicted', 'order_mismatch', 'amount_mismatch', 'verification_pending']);

const MONEY = /^(?!0+(\.0{1,2})?$)\d{1,7}(\.\d{1,2})?$/;

/** A positive EGP amount, up to 1,000,000, two decimals at most. */
export function validMoney(value: string): boolean {
  return MONEY.test(value.trim()) && Number(value) <= 1_000_000;
}

/** The sum of the lines in piastres-exact arithmetic, or null when one is invalid. */
export function linesTotal(lines: readonly { amount: string }[]): string | null {
  if (!lines.length || lines.some((l) => !validMoney(l.amount))) return null;
  const cents = lines.reduce((sum, l) => sum + Math.round(Number(l.amount.trim()) * 100), 0);
  return (cents / 100).toFixed(2);
}

/** Whether a line is complete: both descriptions and an amount. */
export function lineReady(l: { descriptionEn: string; descriptionAr: string; amount: string }): boolean {
  return l.descriptionEn.trim() !== '' && l.descriptionAr.trim() !== '' && validMoney(l.amount);
}

/** A transfer or a cheque carries its reference; cash none. */
export const needsReference = (method: string) => method === 'bank_transfer' || method === 'cheque';

const REFERENCE = /^[A-Za-z0-9/-]{1,40}$/;
export const validReference = (value: string) => REFERENCE.test(value.trim());

/** The first day of the month of a `YYYY-MM-DD` day. */
export function firstOfMonth(day: string): string {
  return `${day.slice(0, 8)}01`;
}

/** The first of the next `n` months as options, from this month. */
export function monthStarts(today: string, n = 13): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return Array.from({ length: n }, (_, i) => {
    const index = y * 12 + (m - 1) + i;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
  });
}

/** A credential as the API shows it: its last four characters. */
export const masked = (last4: string | null | undefined) => (last4 ? `••••${last4}` : '—');

/** Six digits, as the step-up email sends them. */
export const validCode = (code: string) => /^\d{6}$/.test(code.trim());

/** Paymob Egypt keys, and whether they fit the mode. */
export function keyProblem(key: string, kind: 'sk' | 'pk', mode: 'sandbox' | 'live'): string | undefined {
  const v = key.trim();
  if (!v) return undefined;
  if (!new RegExp(`^egy_${kind}_(test|live)_[A-Za-z0-9_-]{8,240}$`).test(v)) return `Starts with egy_${kind}_test_ or egy_${kind}_live_.`;
  const live = v.startsWith(`egy_${kind}_live_`);
  if (live !== (mode === 'live')) return mode === 'live' ? 'Live mode takes a live key.' : 'Sandbox takes a test key.';
  return undefined;
}

// Finance part 2 (ADR 0048).

/** `YYYY-MM-DD` plus `n` months: the same day, or the month's last when it has none. */
export function addMonths(day: string, n: number): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 + n;
  const d = Number(day.slice(8, 10));
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * What an invoice owes as `count` monthly instalments from `firstDue`:
 * equal parts in piastres, the remainder on the last, so they add up to
 * exactly the total (the API refuses anything else).
 */
export function splitEqually(total: string, count: number, firstDue: string): { dueOn: string; amount: string }[] {
  const cents = Math.round(Number(total) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || count < 1) return [];
  const each = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) => ({
    dueOn: addMonths(firstDue, i),
    amount: ((i === count - 1 ? cents - each * (count - 1) : each) / 100).toFixed(2),
  }));
}

/** Instalments the API takes: 2–24, each at least 1.00, due dates rising. */
export function instalmentsProblem(rows: readonly { dueOn: string; amount: string }[], owed: string): string | undefined {
  if (rows.length < 2 || rows.length > 24) return 'Between 2 and 24 instalments.';
  if (rows.some((r) => !validMoney(r.amount) || Number(r.amount) < 1)) return 'Each instalment is at least 1.00 EGP.';
  if (rows.some((r, i) => i > 0 && r.dueOn <= (rows[i - 1]?.dueOn ?? ''))) return 'Each instalment falls due after the one before.';
  if (linesTotal(rows) !== Number(owed).toFixed(2)) return `They must add up to ${Number(owed).toFixed(2)} EGP.`;
  return undefined;
}

/** What a credit note may still take off an invoice: its total less credit notes. */
export const creditable = (i: { total: string; credited: string }) => (Math.round((Number(i.total) - Number(i.credited)) * 100) / 100).toFixed(2);

export const LEDGER_TEXT: Record<string, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  payment: 'Payment',
  payment_reversal: 'Payment reversed',
  refund: 'Refund',
  refund_reversal: 'Refund reversed',
  credit_applied: 'Credit applied',
  allocation_release: 'Released to credit',
};

export const REFUND_CHANNEL_TEXT: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  gateway_manual: 'In the payment provider’s dashboard',
};

/** A file name a download falls back on when the server names none. */
export function downloadName(disposition: string | null, fallback: string): string {
  return /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? fallback;
}
