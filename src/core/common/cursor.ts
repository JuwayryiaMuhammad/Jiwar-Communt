import { isUUID } from 'class-validator';
import { appError, ErrorCode, FieldErrorCode } from './errors';

export interface Page<T> {
  items: T[];
  /** Opaque; pass back as `cursor` for the next (older) page. Null at the end. */
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Keyset pagination on (timestamp, id): unique, so pages have no gaps and
 * no duplicates even when many rows share a timestamp. Newest first by
 * default; review queues use `asc` (oldest first). The cursor is opaque
 * base64url of [iso, id] in both directions, so every list in the API has
 * the same cursor format; a malformed one is VALIDATION_FAILED on `cursor`
 * (INVALID_FORMAT).
 */
export function keysetCursor<F extends string>(
  field: F,
  direction: 'asc' | 'desc' = 'desc',
) {
  const past = direction === 'desc' ? 'lt' : 'gt';
  const encode = (row: { [K in F]: Date } & { id: string }): string =>
    Buffer.from(JSON.stringify([row[field].toISOString(), row.id])).toString(
      'base64url',
    );

  const decode = (cursor: string): { at: Date; id: string } => {
    try {
      const [iso, id] = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as [unknown, unknown];
      const at = typeof iso === 'string' ? new Date(iso) : new Date(NaN);
      if (!Number.isNaN(at.getTime()) && typeof id === 'string' && isUUID(id)) {
        return { at, id };
      }
    } catch {
      // fall through
    }
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', {
      fields: [{ field: 'cursor', code: FieldErrorCode.INVALID_FORMAT }],
    });
  };

  return {
    encode,
    decode,
    /** "Strictly past the cursor" in page order, as a `where` condition (or none). */
    after(cursor: string | undefined): object[] {
      if (!cursor) return [];
      const c = decode(cursor);
      return [
        {
          OR: [
            { [field]: { [past]: c.at } },
            { [field]: c.at, id: { [past]: c.id } },
          ],
        },
      ];
    },
    orderBy: [{ [field]: direction }, { id: direction }] as {
      [key: string]: 'asc' | 'desc';
    }[],
    /** Rows fetched with limit + 1, to know whether another page exists. */
    toPage<T extends { [K in F]: Date } & { id: string }>(
      rows: T[],
      limit: number,
    ): Page<T> {
      const items = rows.slice(0, limit);
      return {
        items,
        nextCursor:
          rows.length > limit ? encode(items[items.length - 1]) : null,
      };
    },
  };
}
