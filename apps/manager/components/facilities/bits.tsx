'use client';

import { Badge } from '@jiwar/ui';
import { describeWindows } from '@/components/management-requests/logic';
import type { Facility } from '@/lib/queries';

export { Back } from '@/components/neighbours/bits';

/** A facility's kind and state, as badges. */
export function FacilityBadges({ facility }: { facility: Facility }) {
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <Badge tone={facility.mode === 'bookable' ? 'green' : 'beige'}>{facility.mode === 'bookable' ? 'Bookable' : 'Walk-in'}</Badge>
      {!facility.active ? <Badge tone="beige">Retired</Badge> : null}
      {facility.rules?.requiresApproval ? <Badge tone="terracotta">Approval</Badge> : null}
      {facility.rules?.requiresMembership ? <Badge tone="dark">Members</Badge> : null}
      {facility.rules?.childOccasions ? <Badge tone="beige">Children’s occasions</Badge> : null}
    </span>
  );
}

/** "Sun 06:00–22:00" lines, or "No hours". */
export function HoursText({ facility }: { facility: Facility }) {
  const lines = describeWindows(facility.hours);
  return lines.length ? (
    <span className="stack stack--sm t-secondary">
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </span>
  ) : (
    <span className="t-secondary">No hours: no slot is offered</span>
  );
}

/** "60 min · 4 people" for a bookable facility. */
export function rulesText(facility: Facility): string {
  if (!facility.rules) return 'Hours only';
  const r = facility.rules;
  return `${r.slotMinutes} min slots · ${r.capacity} ${r.capacityUnit === 'people' ? 'people' : r.capacity === 1 ? 'booking' : 'bookings'}`;
}
