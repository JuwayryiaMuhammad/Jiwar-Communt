/**
 * Words for the asset register (ADR 0064). Plain TypeScript with type-only
 * imports, so the node tests run it as is; the words are in the
 * `assets-format` catalog, handed in as `t`.
 */
import type { Format, Locale, Translate } from '@jiwar/i18n/core';
import type en from '../../messages/en/assets-format.ts';

export type Tone = 'green' | 'beige' | 'terracotta' | 'error';
export type FormatT = Translate<typeof en>;
/** The words for an API code (`useLabel()`). */
export type Label = (code: string | null | undefined) => string;

export const HEALTH_TONE: Record<'good' | 'watch' | 'poor', Tone> = { good: 'green', watch: 'beige', poor: 'error' };

export const CONDITION_TONE: Record<string, Tone> = { good: 'green', fair: 'beige', poor: 'terracotta', critical: 'error' };

/** A record's name in the page's language. */
export function nameOf(locale: Locale, x: { nameEn: string; nameAr: string }): string {
  return locale === 'ar' ? x.nameAr || x.nameEn : x.nameEn;
}

const UNITS = ['day', 'week', 'month', 'year'] as const;
type SeriesUnit = (typeof UNITS)[number];

/** "Every 3 months", "Every week, from the day it was last done". */
export function seriesText(t: FormatT, p: { every: number | null; unit: string | null; basis?: string | null }): string {
  if (p.every === null || p.unit === null || !(UNITS as readonly string[]).includes(p.unit)) return '—';
  const each = t(`every.${p.unit as SeriesUnit}`, { n: p.every });
  return p.basis === 'floating' ? t('floating', { each }) : each;
}

/** Where an asset is: its unit's code, or its area's code and name. */
export function placeText(
  t: FormatT,
  locale: Locale,
  a: { unitCode: string | null; commonArea: { code: string; nameEn: string; nameAr: string } | null },
): string {
  if (a.unitCode) return t('unit', { code: a.unitCode });
  if (a.commonArea) return `${a.commonArea.code} · ${nameOf(locale, a.commonArea)}`;
  return '—';
}

const FIELDS = new Set([
  'code',
  'nameEn',
  'nameAr',
  'manufacturer',
  'model',
  'serialNumber',
  'vendorName',
  'vendorPhone',
  'warrantyStartsOn',
  'warrantyEndsOn',
  'warrantor',
  'warrantyCovers',
  'replacementCost',
  'purchaseValue',
  'commissionedOn',
  'lifeYears',
  'downtimeCostPerDay',
  'servesBuildings',
  'criticality',
  'condition',
]);

/** A history entry in words; codes in their words (`label`). */
export function eventText(
  e: { kind: string; fromValue: string | null; toValue: string | null; reasonCode: string | null },
  w: { t: FormatT; fmt: Format; label: Label },
): string {
  const { t, fmt, label } = w;
  const reason = e.reasonCode ? label(e.reasonCode) : null;
  switch (e.kind) {
    case 'created':
      return t('event.created');
    case 'imported':
      return t('event.imported');
    case 'updated': {
      const fields = (e.toValue ?? '')
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => (FIELDS.has(f) ? t(`field.${f}` as keyof typeof en) : f));
      return t('event.updated', { fields: fmt.list(fields) });
    }
    case 'condition_changed':
      return t('event.condition_changed', { from: label(e.fromValue), to: label(e.toValue) });
    case 'status_changed':
      return reason
        ? t('event.status_changedWhy', { from: label(e.fromValue), to: label(e.toValue), reason })
        : t('event.status_changed', { from: label(e.fromValue), to: label(e.toValue) });
    case 'moved':
      return t('event.moved');
    case 'retired':
      return reason ? t('event.retiredWhy', { reason }) : t('event.retired');
    case 'tag_issued':
      return t('event.tag_issued');
    case 'replacement_recommended':
      return reason ? t('event.replacement_recommendedWhy', { reason }) : t('event.replacement_recommended');
    case 'replacement_decided':
      return reason
        ? t('event.replacement_decidedWhy', { decision: label(e.toValue), reason })
        : t('event.replacement_decided', { decision: label(e.toValue) });
    default:
      return label(e.kind);
  }
}
