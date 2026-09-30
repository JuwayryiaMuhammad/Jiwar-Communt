import { keysetCursor } from '../common/cursor';

export {
  clampLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type Page,
} from '../common/cursor';

/** Audit pages: newest first on (occurred_at, id) (ADR 0014). */
const cursor = keysetCursor('occurredAt');

export interface PageQuery {
  cursor?: string;
  /** 1–100, default 50. */
  limit?: number;
  from?: Date;
  to?: Date;
}

export const encodeCursor = cursor.encode;
export const decodeCursor = cursor.decode;
export const toPage = cursor.toPage.bind(cursor);
export const NEWEST_FIRST = cursor.orderBy;

/** The shared `where` for a page: time window plus "older than the cursor". */
export function pageWhere(q: PageQuery) {
  const and: object[] = [];
  if (q.from) and.push({ occurredAt: { gte: q.from } });
  if (q.to) and.push({ occurredAt: { lt: q.to } });
  and.push(...cursor.after(q.cursor));
  return and;
}
