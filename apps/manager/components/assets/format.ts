/**
 * Words for the asset register (ADR 0064). Plain TypeScript with no
 * imports, so the node tests run it as is.
 */
export type Tone = 'green' | 'beige' | 'terracotta' | 'error';

export const HEALTH_TONE: Record<'good' | 'watch' | 'poor', Tone> = { good: 'green', watch: 'beige', poor: 'error' };

export const CONDITION_TONE: Record<string, Tone> = { good: 'green', fair: 'beige', poor: 'terracotta', critical: 'error' };

/** "Every 3 months", "Every week, from the day it was last done". */
export function seriesText(p: { every: number | null; unit: string | null; basis?: string | null }): string {
  if (p.every === null || p.unit === null) return '—';
  const unit = p.every === 1 ? p.unit : `${p.unit}s`;
  const each = p.every === 1 ? `Every ${unit}` : `Every ${p.every} ${unit}`;
  return p.basis === 'floating' ? `${each}, from the day it was last done` : each;
}

/** Where an asset is: its unit's code, or its area's code and name. */
export function placeText(a: { unitCode: string | null; commonArea: { code: string; nameEn: string } | null }): string {
  if (a.unitCode) return `Unit ${a.unitCode}`;
  if (a.commonArea) return `${a.commonArea.code} · ${a.commonArea.nameEn}`;
  return '—';
}

/** A history entry in words; codes stay codes, humanized. */
export function eventText(e: { kind: string; fromValue: string | null; toValue: string | null; reasonCode: string | null }): string {
  const words = (v: string | null) => (v ?? '').replace(/_/g, ' ');
  const why = e.reasonCode ? ` (${words(e.reasonCode)})` : '';
  switch (e.kind) {
    case 'created':
      return 'Added to the register';
    case 'imported':
      return 'Imported from a sheet';
    case 'updated':
      return `Card updated: ${words(e.toValue).split(',').join(', ')}`;
    case 'condition_changed':
      return `Condition ${words(e.fromValue)} → ${words(e.toValue)}`;
    case 'status_changed':
      return `${words(e.fromValue)} → ${words(e.toValue)}${why}`;
    case 'moved':
      return 'Moved';
    case 'retired':
      return `Retired${why}`;
    case 'tag_issued':
      return 'New tag issued';
    case 'replacement_recommended':
      return `Replacement recommended${why}`;
    case 'replacement_decided':
      return `Replacement ${words(e.toValue)}${why}`;
    default:
      return words(e.kind);
  }
}

/** A rate of 0–1 as a percentage, or a dash with none. */
export function rateText(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}
