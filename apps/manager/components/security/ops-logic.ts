/**
 * The security screens of ADR 0053 (lockdown, blocklist, incidents,
 * violations), as the API holds their rules. Plain TypeScript with no
 * imports, so the tests run it as is.
 */

/** "Every gate", or the gate's name. */
export function lockdownScope(l: { scope: string; gate?: { name: string } | null }): string {
  return l.scope === 'all' ? 'Every gate' : (l.gate?.name ?? 'A gate');
}

/** The banner's line for the live lockdowns: "Every gate, Main gate". */
export function lockdownBanner(live: readonly { scope: string; gate?: { name: string } | null }[]): string | null {
  if (!live.length) return null;
  const all = live.some((l) => l.scope === 'all');
  const gates = live.filter((l) => l.scope !== 'all').map(lockdownScope);
  const parts = [...(all ? ['Every gate'] : []), ...gates];
  return `Lockdown in force: ${parts.join(', ')}`;
}

/** What a blocklist entry is about: its plate, the person's name, or a purged person. */
export function blocklistSubject(e: { subject: string; plate?: string | null; fullName?: string | null }): string {
  if (e.subject === 'plate') return e.plate ?? '—';
  return e.fullName ?? 'A person (purged)';
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
  return hours === null || hours === undefined ? '—' : `${hours} h`;
}
