import { isUUID } from 'class-validator';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';

export interface Page<T> {
  items: T[];
  /** Opaque; pass back as `cursor` for the next (older) page. Null at the end. */
  nextCursor: string | null;
}

export interface PageQuery {
  cursor?: string;
  /** 1–100, default 50. */
  limit?: number;
  from?: Date;
  to?: Date;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** Position after an entry, newest first: (occurred_at, id). */
export function encodeCursor(entry: { occurredAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify([entry.occurredAt.toISOString(), entry.id]),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  try {
    const [iso, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [unknown, unknown];
    const occurredAt = typeof iso === 'string' ? new Date(iso) : new Date(NaN);
    if (
      !Number.isNaN(occurredAt.getTime()) &&
      typeof id === 'string' &&
      isUUID(id)
    ) {
      return { occurredAt, id };
    }
  } catch {
    // fall through
  }
  throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', {
    fields: [{ field: 'cursor', code: FieldErrorCode.INVALID_FORMAT }],
  });
}

/**
 * The shared `where` for a page: time window plus "strictly older than the
 * cursor" on (occurred_at, id), which is unique — no gaps and no duplicates
 * even when many entries share a timestamp.
 */
export function pageWhere(q: PageQuery) {
  const and: object[] = [];
  if (q.from) and.push({ occurredAt: { gte: q.from } });
  if (q.to) and.push({ occurredAt: { lt: q.to } });
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    and.push({
      OR: [
        { occurredAt: { lt: c.occurredAt } },
        { occurredAt: c.occurredAt, id: { lt: c.id } },
      ],
    });
  }
  return and;
}

export const NEWEST_FIRST = [
  { occurredAt: 'desc' as const },
  { id: 'desc' as const },
];

/** Fetches limit + 1 to know whether another page exists. */
export function toPage<T extends { occurredAt: Date; id: string }>(
  rows: T[],
  limit: number,
): Page<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor:
      rows.length > limit ? encodeCursor(items[items.length - 1]) : null,
  };
}
