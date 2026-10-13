import type { Announcement } from '@prisma/client';

// ============================================================================
// An announcement's life (ADR 0040), as pure functions of the row and the
// database's clock. Nothing is stored about it but the dates: publication,
// expiry, a pin's end and the end of works all happen by themselves, at
// read time.
// ============================================================================

/**
 * - draft: not published, no date set;
 * - scheduled: its date is ahead;
 * - published: out now;
 * - expired: a general announcement past its expiry;
 * - ended: works whose end has passed;
 * - archived: taken down by the staff, for good.
 */
export type AnnouncementStatus =
  'draft' | 'scheduled' | 'published' | 'expired' | 'ended' | 'archived';

type Dates = Pick<
  Announcement,
  'publishAt' | 'expiresAt' | 'archivedAt' | 'worksEndsAt'
>;

export function statusOf(a: Dates, now: Date): AnnouncementStatus {
  if (a.archivedAt) return 'archived';
  if (!a.publishAt) return 'draft';
  if (a.publishAt > now) return 'scheduled';
  if (a.worksEndsAt && a.worksEndsAt <= now) return 'ended';
  if (a.expiresAt && a.expiresAt <= now) return 'expired';
  return 'published';
}

/** Out now: what its audience reads. */
export const isOut = (a: Dates, now: Date) => statusOf(a, now) === 'published';

/** Not out yet: its audience and its date may still change. */
export const isAhead = (a: Dates, now: Date) => {
  const status = statusOf(a, now);
  return status === 'draft' || status === 'scheduled';
};

/** Pinned now: important, out, and its pin's date ahead. */
export function isPinned(
  a: Dates & Pick<Announcement, 'priority' | 'pinnedUntil'>,
  now: Date,
): boolean {
  return (
    isOut(a, now) &&
    a.priority === 'important' &&
    a.pinnedUntil !== null &&
    a.pinnedUntil > now
  );
}

/** Works under way now: started, not ended, and out. */
export function worksActive(
  a: Dates & Pick<Announcement, 'worksStartsAt'>,
  now: Date,
): boolean {
  return (
    isOut(a, now) &&
    a.worksStartsAt !== null &&
    a.worksStartsAt <= now &&
    a.worksEndsAt !== null &&
    a.worksEndsAt > now
  );
}

/**
 * `isOut` as a query condition, for the lists: published, not archived,
 * not expired, and (works) not ended.
 */
export function outWhere(now: Date) {
  return {
    publishAt: { lte: now },
    archivedAt: null,
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: [{ worksEndsAt: null }, { worksEndsAt: { gt: now } }] },
    ],
  };
}

/** Each status as a query condition, for the staff's filter. */
export function statusWhere(status: AnnouncementStatus, now: Date) {
  switch (status) {
    case 'archived':
      return { archivedAt: { not: null } };
    case 'draft':
      return { archivedAt: null, publishAt: null };
    case 'scheduled':
      return { archivedAt: null, publishAt: { gt: now } };
    case 'ended':
      return {
        archivedAt: null,
        publishAt: { lte: now },
        worksEndsAt: { lte: now },
      };
    case 'expired':
      return {
        archivedAt: null,
        publishAt: { lte: now },
        expiresAt: { lte: now },
      };
    case 'published':
      return outWhere(now);
  }
}
