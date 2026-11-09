/**
 * A tender's bid link (ADR 0088): what the page may offer now, and the
 * bid's body as the API takes it. Plain TypeScript, tested as is.
 */

export type BidLinkPage = {
  id: string;
  reference: string;
  title: string;
  scope: string | null;
  category: string;
  status: 'open' | 'closed' | 'awarded' | 'cancelled';
  bidsDueAt: string;
  documents: { id: string; title: string; fileUrl: string | null }[];
  bid: { id: string; submittedAt: string; withdrawnAt: string | null; sealed: boolean; amount: string | null } | null;
  outcome: 'awarded' | 'not_awarded' | 'cancelled' | null;
  compoundName: string;
  companyName: string;
  /** The link's documents: drafts, and the live bid's (`sent`); never a link to one. */
  bidDocuments: BidDocument[];
  maxBidDocuments: number;
};

export type BidDocument = { id: string; title: string; contentType: string; ready: boolean; sent: boolean };

/** What a bid document may be (the API's `tender_bid` purpose): an image or a PDF, 10 MB. */
export const BID_DOCUMENT_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const BID_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** A file the page may start uploading, or the code the API would answer. */
export function documentRefusal(file: { type: string; size: number }): 'FILE_TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE' | null {
  if (!BID_DOCUMENT_TYPES.includes(file.type)) return 'FILE_TYPE_NOT_ALLOWED';
  if (file.size > BID_DOCUMENT_MAX_BYTES) return 'FILE_TOO_LARGE';
  return null;
}

/** The drafts the bid carries: the ones that arrived (the rest are deleted when it is sent). */
export function sendableDocuments(page: Pick<BidLinkPage, 'bidDocuments'>): string[] {
  return page.bidDocuments.filter((d) => !d.sent && d.ready).map((d) => d.id);
}

/** The API's trades (VENDOR_CATEGORIES). */
export const TENDER_CATEGORIES = [
  'maintenance',
  'cleaning',
  'security',
  'landscaping',
  'pest_control',
  'supplies',
  'utilities',
  'professional',
  'other',
] as const;

/** The bid's limits, as the API states them (tender-rules.ts). */
export const BID_LIMITS = { note: { min: 1, max: 2000 }, durationDays: { min: 1, max: 3650 }, documentTitle: { min: 1, max: 120 } } as const;

/** EGP, more than zero, up to two decimals (the API's MONEY). */
const MONEY = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;

/** A live bid: sent and not withdrawn. */
export function liveBid(page: Pick<BidLinkPage, 'bid'>): boolean {
  return page.bid !== null && page.bid.withdrawnAt === null;
}

/**
 * What the company may do now: send a bid while the tender takes them and
 * it has none live; withdraw its live one before the deadline. Nothing once
 * the deadline passed (the API answers TENDER_CLOSED anyway).
 */
export function bidActions(page: Pick<BidLinkPage, 'status' | 'bid'>): ('bid' | 'withdraw')[] {
  if (page.status !== 'open') return [];
  return liveBid(page) ? ['withdraw'] : ['bid'];
}

export type BidForm = { amount: string; durationDays: string; note: string };

/**
 * The body the API takes, or null while the form is not sendable: an
 * amount it accepts, a whole number of days within the limits or nothing,
 * a note within its length or nothing.
 */
export function bidBody(
  form: BidForm,
  fileIds: readonly string[] = [],
): { amount: string; durationDays?: number; note?: string; fileIds?: string[] } | null {
  const amount = form.amount.trim();
  if (!MONEY.test(amount)) return null;
  const days = form.durationDays.trim();
  if (days && !/^\d{1,4}$/.test(days)) return null;
  const durationDays = days ? Number(days) : undefined;
  if (durationDays !== undefined && (durationDays < BID_LIMITS.durationDays.min || durationDays > BID_LIMITS.durationDays.max)) return null;
  const note = form.note.trim();
  if (note.length > BID_LIMITS.note.max) return null;
  return {
    amount,
    ...(durationDays !== undefined ? { durationDays } : {}),
    ...(note ? { note } : {}),
    ...(fileIds.length ? { fileIds: [...fileIds] } : {}),
  };
}

/** A document's presigned URL when it is http(s); anything else, null. */
export function documentHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
