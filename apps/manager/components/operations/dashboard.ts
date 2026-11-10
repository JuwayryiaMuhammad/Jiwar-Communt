/**
 * The operations dashboard's alerts (ADR 0079): which page each opens and
 * what it says, and a building's band as a badge's tone. Plain TypeScript,
 * type imports only; the words are in the shell-overview catalog.
 */
import type { Translate } from '@jiwar/i18n/core';
import type en from '../../messages/en/shell-overview.ts';

export const ALERT = {
  emergency_overdue: { href: '/maintenance' },
  emergency_unassigned: { href: '/maintenance' },
  lockdown_live: { href: '/security/lockdowns' },
  incident_critical_open: { href: '/security/incidents' },
  tickets_overdue: { href: '/maintenance' },
  service_pressure: { href: '/maintenance' },
  outage_active: { href: '/outages' },
  meter_alert_open: { href: '/meters' },
  // Cash flow (ADR 0091): the count is the forecast's periods closing below the minimum.
  cash_below_minimum: { href: '/finance/cash-flow' },
  cash_forecast_below_minimum: { href: '/finance/cash-flow' },
} as const satisfies Record<string, { href: string }>;

type AlertCode = keyof typeof ALERT;
const isAlert = (code: string): code is AlertCode => Object.prototype.hasOwnProperty.call(ALERT, code);

export function alertHref(code: string): string {
  return isAlert(code) ? ALERT[code].href : '/';
}

/** What an alert says; an unknown code shows its words and its count. */
export function alertText(t: Translate<typeof en>, code: string, count: number): string {
  return isAlert(code) ? t(`alert.${code}`, { n: count }) : t('alert.other', { what: code.replace(/_/g, ' '), n: count });
}

export const BAND_TONE: Record<string, 'green' | 'beige' | 'terracotta'> = {
  ok: 'green',
  attention: 'beige',
  critical: 'terracotta',
};

const BANDS = ['ok', 'attention', 'critical'] as const;

/** A building's band in words, or the code itself when it is new. */
export function bandText(t: Translate<typeof en>, band: string): string {
  return (BANDS as readonly string[]).includes(band) ? t(`band.${band as (typeof BANDS)[number]}`) : band;
}
