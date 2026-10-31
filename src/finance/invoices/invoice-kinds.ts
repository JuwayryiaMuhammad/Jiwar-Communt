import type { InvoiceKind } from '@prisma/client';

/**
 * What the staff issue and the billing plans bill (ADR 0046). The charges
 * port alone issues the rest — `facility`, `club`, `fine` (ADR 0070) — so a
 * booking, a club request or a fine owes through exactly one invoice.
 */
export const STAFF_INVOICE_KINDS = [
  'service_charge',
  'maintenance',
  'other',
] as const satisfies readonly InvoiceKind[];
export type StaffInvoiceKind = (typeof STAFF_INVOICE_KINDS)[number];

/** Not a charge's: split into instalments and disputed as ADR 0048 says. */
export const isStaffKind = (kind: InvoiceKind): boolean =>
  (STAFF_INVOICE_KINDS as readonly InvoiceKind[]).includes(kind);
