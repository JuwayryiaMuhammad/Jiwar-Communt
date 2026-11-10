'use client';

import { Badge } from '@jiwar/ui';
import { eventTone, useCodeLabel } from '@/lib/labels';

/** A security event in the page's language, its code on hover. */
export function EventBadge({ event }: { event: string }) {
  const label = useCodeLabel();
  return (
    <span title={event}>
      <Badge tone={eventTone(event)}>{label(event)}</Badge>
    </span>
  );
}
