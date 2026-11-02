/**
 * The operations dashboard's words (ADR 0079): what each alert says and
 * which page it opens, and a building's band as a badge. Plain TypeScript,
 * no imports.
 */
export const ALERT: Record<string, { label: (count: number) => string; href: string }> = {
  emergency_overdue: { label: (n) => `${n} emergency ticket${n === 1 ? '' : 's'} past the SLA`, href: '/maintenance' },
  emergency_unassigned: { label: (n) => `${n} emergency ticket${n === 1 ? '' : 's'} with nobody assigned`, href: '/maintenance' },
  lockdown_live: { label: (n) => `${n} lockdown${n === 1 ? '' : 's'} in force`, href: '/security/lockdowns' },
  incident_critical_open: { label: (n) => `${n} critical incident${n === 1 ? '' : 's'} open`, href: '/security/incidents' },
  tickets_overdue: { label: (n) => `${n} ticket${n === 1 ? '' : 's'} past the SLA`, href: '/maintenance' },
  service_pressure: { label: (n) => `Service pressure: ${n} open tickets for the technicians available`, href: '/maintenance' },
  outage_active: { label: (n) => `${n} utility outage${n === 1 ? '' : 's'} in force`, href: '/outages' },
  meter_alert_open: { label: (n) => `${n} meter spike${n === 1 ? '' : 's'} not yet acknowledged`, href: '/meters' },
};

export function alertText(code: string, count: number): string {
  return ALERT[code]?.label(count) ?? `${code.replace(/_/g, ' ')} (${count})`;
}

export const BAND: Record<string, { label: string; tone: 'green' | 'beige' | 'terracotta' }> = {
  ok: { label: 'OK', tone: 'green' },
  attention: { label: 'Attention', tone: 'beige' },
  critical: { label: 'Critical', tone: 'terracotta' },
};

/** A share, 0–1, as a percentage; a dash for none. */
export function percent(share: number | null | undefined): string {
  return share === null || share === undefined ? '—' : `${Math.round(share * 1000) / 10}%`;
}
