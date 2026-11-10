/**
 * The gate offline (ADR 0057), as the API holds its rules: what each flag
 * says, how a device stands, what a quarantined batch holds. Plain
 * TypeScript importing only the layer's core and its catalog, by relative
 * path, so the tests run it as is.
 *
 * The `…In(…, locale)` helpers give the words in the page's language (a
 * code's words through the page's `label`, from `useLabel()`); the English
 * ones are kept for the pages not moved yet.
 */
import { createFormat, translator, type Locale } from '@jiwar/i18n/core';
import ar from '../../messages/ar/guard-offline.ts';
import en from '../../messages/en/guard-offline.ts';

const words = (locale: Locale) => translator(locale, en, ar);
const spaced = (code: string) => code.replace(/_/g, ' ');
type Label = (code: string) => string;

/** A flag's words in the page's language, with what its codes and numbers add. */
export function flagTextIn(f: { kind: string; params: Record<string, unknown> }, locale: Locale, label: Label = spaced): string {
  const t = words(locale);
  const key = `flag.${f.kind}`;
  const base = key in en ? t(key as keyof typeof en) : label(f.kind);
  const p = f.params ?? {};
  const extra: string[] = [];
  if (typeof p.reason === 'string' && p.reason !== f.kind) extra.push(label(p.reason));
  if (typeof p.code === 'string') extra.push(label(p.code.toLowerCase()));
  if (typeof p.skewSeconds === 'number') extra.push(t(p.skewSeconds < 0 ? 'skewEarly' : 'skewLate', { s: Math.abs(p.skewSeconds) }));
  if (typeof p.offsetSeconds === 'number')
    extra.push(t(p.offsetSeconds < 0 ? 'clockBehind' : 'clockAhead', { s: Math.abs(p.offsetSeconds) }));
  if (typeof p.matches === 'number') extra.push(t('matching', { n: p.matches }));
  return extra.length ? `${base} (${extra.join(locale === 'ar' ? '، ' : ', ')})` : base;
}

/** How a device stands (as `deviceState`), its words in the page's language. */
export function deviceStateIn(
  d: DeviceHealth,
  now: number,
  alertMinutes: number,
  locale: Locale,
): { tone: 'error' | 'terracotta' | 'green' | 'beige'; text: string } {
  const t = words(locale);
  if (d.status === 'revoked') return { tone: 'beige', text: t('device.revoked') };
  const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
  const quietMinutes = Number.isNaN(seen) ? null : Math.floor((now - seen) / 60_000);
  if (d.onShift && quietMinutes !== null && quietMinutes >= alertMinutes) return { tone: 'error', text: t('device.quiet', { n: quietMinutes }) };
  if (d.missingActions > 0) return { tone: 'error', text: t('device.missing', { n: d.missingActions }) };
  if (d.openFlags > 0) return { tone: 'terracotta', text: t('device.flags', { n: d.openFlags }) };
  return d.onShift ? { tone: 'green', text: t('device.onShift') } : { tone: 'beige', text: t('device.offShift') };
}

/** What the device's last bundle could not carry, in the page's language; null when everything was. */
export function notCarriedTextIn(n: { passes: number; workers: number }, locale: Locale): string | null {
  const t = words(locale);
  const parts: string[] = [];
  if (n.passes > 0) parts.push(t('notCarried.passes', { n: n.passes }));
  if (n.workers > 0) parts.push(t('notCarried.workers', { n: n.workers }));
  return parts.length ? t('notCarried', { what: createFormat(locale).list(parts) }) : null;
}

/** What a quarantined batch holds, in the page's language. */
export function batchSummaryIn(actions: { type: string; status: string }[], locale: Locale, label: Label = spaced): string {
  const fmt = createFormat(locale);
  const counts = new Map<string, number>();
  for (const a of actions) if (a.status === 'quarantined') counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => (locale === 'ar' ? `${label(type)}: ${fmt.number(n)}` : `${fmt.number(n)} ${label(type)}`))
    .join(locale === 'ar' ? '، ' : ', ');
}

/** What each flag the server raised at sync means, in a few words. */
export const FLAG_TEXT: Record<string, string> = {
  lockdown_entered: 'Let in while a lockdown held the gate',
  blocklist_ban_entered: 'A banned plate let in',
  credential_banned: 'A banned worker, or a stopped permit’s worker, let in',
  once_only_reused: 'A one-time pass used again',
  action_rejected: 'Something that cannot have happened',
  device_revoked_upload: 'A revoked device uploaded: quarantined',
  contractor_unresolved: 'A contractor no worker of the permit matches',
  child_exit_unverified: 'A child released with an escort not verified',
  credential_revoked: 'A pass or card no longer valid then',
  invalid_at_time: 'Outside its validity or hours',
  capacity_exceeded: 'More inside than the pass allows',
  clock_skew: 'The device’s clock was off',
  bundle_expired: 'Decided with an expired bundle',
  shift_ended: 'After its shift had ended',
  patrol_scan_refused: 'A patrol scan the run refused',
  blocklist_watch_entered: 'A watched plate let in',
  already_inside: 'Recorded in while already inside',
  exit_without_entry: 'An exit with nobody inside',
  duplicate_inside: 'A service vehicle recorded in twice',
};

export type FlagClass = 'security' | 'manager' | 'info';

/** The badge tone of a class. */
export function classTone(c: FlagClass): 'error' | 'terracotta' | 'beige' {
  return c === 'security' ? 'error' : c === 'manager' ? 'terracotta' : 'beige';
}

/** A flag's words, with what its codes and numbers add. */
export function flagText(f: { kind: string; params: Record<string, unknown> }): string {
  const base = FLAG_TEXT[f.kind] ?? f.kind.replace(/_/g, ' ');
  const p = f.params ?? {};
  const extra: string[] = [];
  if (typeof p.reason === 'string' && p.reason !== f.kind) extra.push(p.reason.replace(/_/g, ' '));
  if (typeof p.code === 'string') extra.push(p.code.toLowerCase().replace(/_/g, ' '));
  if (typeof p.skewSeconds === 'number') extra.push(`${Math.abs(p.skewSeconds)} s ${p.skewSeconds < 0 ? 'early' : 'late'}`);
  if (typeof p.offsetSeconds === 'number') extra.push(`clock ${Math.abs(p.offsetSeconds)} s ${p.offsetSeconds < 0 ? 'behind' : 'ahead'}`);
  if (typeof p.matches === 'number') extra.push(`${p.matches} matching`);
  return extra.length ? `${base} (${extra.join(', ')})` : base;
}

export interface DeviceHealth {
  status: 'active' | 'revoked';
  onShift: boolean;
  lastSeenAt: string | null;
  missingActions: number;
  openFlags: number;
}

/**
 * How a device stands: revoked; quiet (on shift and not seen for the
 * compound's minutes); missing actions; flags to look at; fine.
 */
export function deviceState(
  d: DeviceHealth,
  now: number,
  alertMinutes: number,
): { tone: 'error' | 'terracotta' | 'green' | 'beige'; text: string } {
  if (d.status === 'revoked') return { tone: 'beige', text: 'Revoked' };
  const seen = d.lastSeenAt ? Date.parse(d.lastSeenAt) : NaN;
  const quietMinutes = Number.isNaN(seen) ? null : Math.floor((now - seen) / 60_000);
  if (d.onShift && quietMinutes !== null && quietMinutes >= alertMinutes)
    return { tone: 'error', text: `Quiet for ${quietMinutes} min` };
  if (d.missingActions > 0)
    return { tone: 'error', text: `${d.missingActions} action${d.missingActions === 1 ? '' : 's'} missing` };
  if (d.openFlags > 0) return { tone: 'terracotta', text: `${d.openFlags} flag${d.openFlags === 1 ? '' : 's'} to look at` };
  return d.onShift ? { tone: 'green', text: 'On shift, syncing' } : { tone: 'beige', text: 'Off shift' };
}

/**
 * What the device's last bundle could not carry: passes from before ADR 0043
 * and worker cards from before ADR 0057 open the gate online only, until
 * reissued. Null when everything was carried.
 */
export function notCarriedText(n: { passes: number; workers: number }): string | null {
  const parts: string[] = [];
  if (n.passes > 0) parts.push(`${n.passes} visitor pass${n.passes === 1 ? '' : 'es'}`);
  if (n.workers > 0) parts.push(`${n.workers} worker card${n.workers === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(' and ')} work online only until reissued` : null;
}

/** What a quarantined batch holds, by what each action says it was. */
export function batchSummary(actions: { type: string; status: string }[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) if (a.status === 'quarantined') counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${n} ${type.replace(/_/g, ' ')}`)
    .join(', ');
}
