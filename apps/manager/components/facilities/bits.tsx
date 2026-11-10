'use client';

import { useFormat, useLocale, useT, type Format, type Translate } from '@jiwar/i18n';
import { Badge } from '@jiwar/ui';
import { clock, sortWindows } from '@/components/management-requests/logic';
import type { Facility } from '@/lib/queries';
import ar from '@/messages/ar/places-facilities';
import en from '@/messages/en/places-facilities';

export { Back } from '@/components/neighbours/bits';

/** A place's name in the page's language: the Arabic one in Arabic when it has one. */
export function useLocalName() {
  const { locale } = useLocale();
  return (x: { nameEn: string; nameAr?: string | null }) => (locale === 'ar' && x.nameAr ? x.nameAr : x.nameEn);
}

/** "Mon, 13 Oct · 09:00–09:30" in the page's language, in the browser's time zone. */
export function slotLine(fmt: Format, startsAt: string, endsAt: string): string {
  return `${fmt.custom(startsAt, { weekday: 'short', day: '2-digit', month: 'short' })} · ${fmt.time(startsAt)}–${fmt.time(endsAt)}`;
}

/** A facility's kind and state, as badges. */
export function FacilityBadges({ facility }: { facility: Facility }) {
  const t = useT(en, ar);
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <Badge tone={facility.mode === 'bookable' ? 'green' : 'beige'}>
        {facility.mode === 'bookable' ? t('badge.bookable') : facility.mode === 'stay' ? t('badge.stay') : t('badge.walk_in')}
      </Badge>
      {!facility.active ? <Badge tone="beige">{t('badge.retired')}</Badge> : null}
      {facility.rules?.requiresApproval ? <Badge tone="terracotta">{t('badge.approval')}</Badge> : null}
      {facility.rules?.requiresMembership ? <Badge tone="dark">{t('badge.members')}</Badge> : null}
      {facility.rules?.childOccasions ? <Badge tone="beige">{t('badge.childOccasions')}</Badge> : null}
    </span>
  );
}

/** "Sunday 06:00–22:00" lines, one per open weekday, or "No hours". */
export function HoursText({ facility }: { facility: Facility }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const sorted = sortWindows(facility.hours);
  const lines = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => {
    const day = sorted.filter((w) => w.weekday === weekday);
    return day.length
      ? [`${fmt.weekday(weekday, 'long')} ${day.map((w) => `${clock(w.startMinute)}–${clock(w.endMinute)}`).join(fmt.locale === 'ar' ? '، ' : ', ')}`]
      : [];
  });
  return lines.length ? (
    <span className="stack stack--sm t-secondary">
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </span>
  ) : (
    <span className="t-secondary">{t('noHours')}</span>
  );
}

/** "60 min slots · 4 people" for a bookable facility. */
export function rulesText(facility: Facility, t: Translate<typeof en>): string {
  if (!facility.rules) return t('hoursOnly');
  const r = facility.rules;
  return r.capacityUnit === 'people'
    ? t('rules.people', { minutes: r.slotMinutes, capacity: r.capacity })
    : t('rules.bookings', { minutes: r.slotMinutes, capacity: r.capacity });
}
