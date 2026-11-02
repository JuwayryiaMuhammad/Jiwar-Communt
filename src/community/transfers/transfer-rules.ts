import type { OwnershipTransfer } from '@prisma/client';

/** An ownership transfer's states (ADR 0083; the CHECK repeats them). */
export const TRANSFER_STATUSES = ['pending', 'done', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** A transfer's reference: `OT-` and its number. */
export const transferReference = (n: number) =>
  `OT-${String(n).padStart(6, '0')}`;

/** A transfer as the management reads it, with what the unit owes now. */
export interface TransferRead {
  transfer: OwnershipTransfer;
  unitCode: string;
  /** The buyer's name; null once erased. */
  buyerName: string | null;
  /** What the unit owes now (finance's amount), while pending; else null. */
  owedNow: string | null;
}
