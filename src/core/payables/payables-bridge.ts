import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// Payables and commitments (ADR 0089)
// ============================================================================
//
// Finance owns the money: commitments that reserve a budget line, vendors'
// invoices, payouts. Maintenance owns what they are against: the compound's
// contracts, their payment schedules and purchase requests (ADR 0077).
// Finance imports no domain (ADR 0046) and nothing imports finance (ADR
// 0055), so the two meet here, in core, at startup, as with BoardMatters
// and VendorDirectory: finance registers the commitment keeper, maintenance
// the sources. A missing one stops the start.

/** What reserves a budget line. */
export type CommitmentSource =
  'contract' | 'purchase_request' | 'purchase_order';

/**
 * One amount a source would spend from a line: a contract's unpaid
 * payment (its id the payment's), or an approved purchase request (its own
 * id). Finance commits only what falls in the line's active budget.
 */
export interface CommitmentItem {
  itemId: string;
  lineId: string;
  amount: string;
  /** The payment's day, or the day a purchase is needed by. */
  dueOn: string | null;
  vendorId: string | null;
}

/** Why an open commitment is given back without an invoice. */
export type CommitmentReleaseReason =
  | 'changed'
  | 'cancelled'
  | 'terminated'
  | 'paid_outside'
  // A purchase request's commitment taken over by its order, and what an
  // order that closed has left (ADR 0094).
  | 'ordered'
  | 'closed';

/**
 * Finance's side, in the source's transaction, after the source's own row
 * lock (the contract or the purchase request, for update): it locks the
 * lines' budgets (shared) and the lines (for update, in id order) and
 * decides by what it reads after them.
 */
export interface CommitmentKeeper {
  /**
   * Makes the source's open commitments these items: one no longer wanted
   * or changed is released with `reason`; a new one is reserved, within
   * what its line has available (BUDGET_LINE_INSUFFICIENT). An item a live
   * vendor invoice names is left as it is.
   */
  sync(
    tx: TenantTxClient,
    ev: {
      source: CommitmentSource;
      sourceId: string;
      items: readonly CommitmentItem[];
      reason: CommitmentReleaseReason;
    },
  ): Promise<void>;
  /**
   * Refuses (CONTRACT_PAYMENT_INVOICED) when a live vendor invoice names
   * one of these contract payments: it is not removed, changed or paid by
   * hand under the invoice.
   */
  assertNotInvoiced(
    tx: TenantTxClient,
    paymentIds: readonly string[],
  ): Promise<void>;
}

/** A contract as a vendor's invoice and a payout read it. */
export interface PayableContract {
  id: string;
  code: string;
  vendorId: string;
  budgetLineId: string | null;
  /** The board's approved major contract it was signed under, if any. */
  approvalRequestId: string | null;
  annualValue: string | null;
  /** What is held back of each payout, a percentage, or null. */
  retentionPct: string | null;
  startsOn: string;
  endsOn: string;
  terminated: boolean;
}

/** One line of a contract's payment schedule. */
export interface PayablePayment {
  id: string;
  contractId: string;
  dueOn: string;
  amount: string;
  paid: boolean;
}

/**
 * A contract's unpaid payment as the cash flow forecast reads it (ADR
 * 0091): what the schedule still says the vendor is paid, and when.
 */
export interface ScheduledPayment {
  id: string;
  contractId: string;
  dueOn: string;
  amount: string;
}

/** What the cash flow forecast needs of a contract: its retention and end. */
export interface ContractTerms {
  id: string;
  /** What is held back of each payout, a percentage, or null. */
  retentionPct: string | null;
  endsOn: string;
  terminated: boolean;
}

/** A purchase request as an invoice reads it. */
export interface PayablePurchase {
  id: string;
  number: number;
  status: string;
  vendorId: string | null;
  budgetLineId: string | null;
  estimatedAmount: string;
  approvalRequestId: string | null;
}

/** One line of a purchase order as an invoice's match reads it (ADR 0094). */
export interface PayableOrderLine {
  id: string;
  position: number;
  kind: string;
  description: string;
  /** Ordered. */
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCode: string;
  withholdingCategory: string | null;
  /** Accepted on receipts so far. */
  accepted: string;
}

/** A purchase order as an invoice and its match read it. */
export interface PayableOrder {
  id: string;
  number: number;
  /** requested | approved | rejected | cancelled | closed */
  status: string;
  vendorId: string;
  budgetLineId: string;
  /** The board's approved major contract it was approved under, if any. */
  approvalRequestId: string | null;
  total: string;
  lines: PayableOrderLine[];
}

/**
 * Maintenance's side: each read locks its row for update (null when
 * unknown) in the caller's transaction, before finance's own rows.
 */
export interface PayableSources {
  contract(tx: TenantTxClient, id: string): Promise<PayableContract | null>;
  payment(tx: TenantTxClient, id: string): Promise<PayablePayment | null>;
  purchase(tx: TenantTxClient, id: string): Promise<PayablePurchase | null>;
  /**
   * A purchase order with its lines and what was accepted of each (ADR
   * 0094), locked for update like the rest.
   */
  order(tx: TenantTxClient, id: string): Promise<PayableOrder | null>;
  /**
   * After an invoice naming the order was approved or called off: the
   * order closes when it is fully received and invoiced, and gives back
   * what its commitment still holds (the order's lock held already).
   */
  orderInvoiced(tx: TenantTxClient, id: string): Promise<void>;
  /**
   * The unpaid payments of the contracts not terminated, due on or before
   * `through` (earlier ones too: overdue), by day. A read, no lock (ADR
   * 0091's forecast).
   */
  unpaid(tx: TenantTxClient, through: string): Promise<ScheduledPayment[]>;
  /** The terms of these contracts (the unknown left out); no lock. */
  terms(tx: TenantTxClient, ids: readonly string[]): Promise<ContractTerms[]>;
  /** A payment paid through the app: marked paid once, with the payout's number. */
  settlePayment(
    tx: TenantTxClient,
    id: string,
    paid: { paidOn: string; reference: string },
  ): Promise<void>;
}

@Injectable()
export class PayablesBridge implements OnApplicationBootstrap {
  private keeper: CommitmentKeeper | null = null;
  private sources: PayableSources | null = null;

  registerCommitments(keeper: CommitmentKeeper): void {
    if (this.keeper) throw new Error('Commitment keeper registered twice');
    this.keeper = keeper;
  }

  registerSources(sources: PayableSources): void {
    if (this.sources) throw new Error('Payable sources registered twice');
    this.sources = sources;
  }

  get commitments(): CommitmentKeeper {
    if (!this.keeper) throw new Error('No commitment keeper');
    return this.keeper;
  }

  get source(): PayableSources {
    if (!this.sources) throw new Error('No payable sources');
    return this.sources;
  }

  onApplicationBootstrap(): void {
    if (!this.keeper) throw new Error('Commitment keeper missing');
    if (!this.sources) throw new Error('Payable sources missing');
  }
}
