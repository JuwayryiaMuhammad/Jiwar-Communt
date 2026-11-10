/**
 * The security screens of ADR 0053 (lockdown, blocklist, incidents,
 * violations), as the API holds their rules. Plain TypeScript importing
 * only the layer's core and the guards' catalog (through ./logic.ts), so
 * the tests run it as is.
 *
 * The `…In(…, locale)` helpers give the words in the page's language; the
 * ones without a locale are their English, kept for the pages not moved yet.
 */
import type { Locale } from '@jiwar/i18n/core';
import { guardWords, listSep } from './logic.ts';

type LockdownLike = { scope: string; gate?: { name: string } | null };

/** "Every gate", or the gate's name. */
export function lockdownScope(l: LockdownLike): string {
  return lockdownScopeIn(l, 'en');
}

/** "Every gate", or the gate's name, in the page's language. */
export function lockdownScopeIn(l: LockdownLike, locale: Locale): string {
  const t = guardWords(locale);
  return l.scope === 'all' ? t('everyGate') : (l.gate?.name ?? t('aGate'));
}

/** The banner's line for the live lockdowns: "Every gate, Main gate". */
export function lockdownBanner(live: readonly LockdownLike[]): string | null {
  return lockdownBannerIn(live, 'en');
}

/** The banner's line for the live lockdowns, in the page's language. */
export function lockdownBannerIn(live: readonly LockdownLike[], locale: Locale): string | null {
  if (!live.length) return null;
  const t = guardWords(locale);
  const all = live.some((l) => l.scope === 'all');
  const gates = live.filter((l) => l.scope !== 'all').map((l) => lockdownScopeIn(l, locale));
  const parts = [...(all ? [t('everyGate')] : []), ...gates];
  return t('lockdownBanner', { gates: parts.join(listSep(locale)) });
}

type BlocklistLike = { subject: string; plate?: string | null; fullName?: string | null };

/** What a blocklist entry is about: its plate, the person's name, or a purged person. */
export function blocklistSubject(e: BlocklistLike): string {
  return blocklistSubjectIn(e, 'en');
}

/** What a blocklist entry is about, a purged person in the page's language. */
export function blocklistSubjectIn(e: BlocklistLike, locale: Locale): string {
  if (e.subject === 'plate') return e.plate ?? '—';
  return e.fullName ?? guardWords(locale)('purgedPerson');
}

/** A plate or a person: what the add form needs before it is sent. */
export function blocklistReady(f: { subject: string; plate: string; fullName: string; idNumber: string; reasonCode: string }): boolean {
  if (!f.reasonCode) return false;
  if (f.subject === 'plate') return f.plate.trim().length > 0;
  return f.fullName.trim().length > 0 && f.idNumber.trim().length > 0;
}

export type IncidentAction = 'assign' | 'note' | 'acknowledge' | 'close';

/**
 * What the management may do on an incident: assign and close until it is
 * closed; notes at any time; acknowledge as reviewer once, never as its
 * author.
 */
export function incidentActions(
  i: { status: string; reportedBy: { id: string }; reviewerAcknowledgedAt?: string | null },
  me: string | undefined,
): IncidentAction[] {
  const out: IncidentAction[] = [];
  if (i.status !== 'closed') out.push('assign');
  out.push('note');
  if (!i.reviewerAcknowledgedAt && me && i.reportedBy.id !== me) out.push('acknowledge');
  if (i.status !== 'closed') out.push('close');
  return out;
}

export type ViolationAction = 'decide' | 'cancel' | 'pay';

/**
 * What the staff may do on a violation: decide an appeal and cancel an
 * open one (`violations.manage`); take the payment of an open one with an
 * amount (`fines.billing`). A warning is never paid.
 */
export function violationActions(
  v: { status: string; isWarning: boolean },
  can: { manage: boolean; billing: boolean },
): ViolationAction[] {
  const out: ViolationAction[] = [];
  if (v.status === 'under_appeal' && can.manage) out.push('decide');
  if (v.status === 'open' && can.manage) out.push('cancel');
  if (v.status === 'open' && !v.isWarning && can.billing) out.push('pay');
  return out;
}

/** The start of a local day (`YYYY-MM-DD`) as an instant, for the API's `from`/`to`. */
export function dayStart(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "2.5 h", or a dash when nothing was closed. */
export function hoursText(hours: number | null | undefined): string {
  return hoursTextIn(hours, 'en');
}

/** "2.5 h" in the page's language, or a dash. */
export function hoursTextIn(hours: number | null | undefined, locale: Locale): string {
  return hours === null || hours === undefined ? '—' : guardWords(locale)('hours', { h: hours });
}
