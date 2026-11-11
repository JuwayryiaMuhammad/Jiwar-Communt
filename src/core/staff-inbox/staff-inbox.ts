import { Injectable } from '@nestjs/common';
import type { Permission } from '../access/permissions';
import type { ThresholdType } from '../board-matters/board-matters';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// The staff inbox (ADR 0073)
// ============================================================================
//
// One queue over what waits for a staff decision, across the domains. Core
// imports no domain (ADR 0015): each domain registers its pending items here
// at startup, as with ResidentItems and BoardMatters, and reads them in the
// caller's tenant transaction (RLS) with the visibility of its own queue.
// The inbox decides nothing itself: every decision is the domain's own route
// and service, with its own locks, triggers and reasons. The one exception
// is a bulk approval of the types whose approval takes no input: the inbox
// calls the domain's own approve, one item at a time.

/** What the inbox gathers, in the order the lists show the types. */
export const INBOX_TYPES = [
  'registration',
  'identity_change',
  'worker_engagement',
  'vehicle',
  'booking',
  'unit_permit',
  'work_permit',
  'field_exception',
  'plan_request',
  'invoice_dispute',
  'decision_appeal',
  'management_request',
  // ADR 0077: a purchase request waiting for its approver.
  'purchase_request',
  // ADR 0084: a common-area use request waiting for the staff.
  'space_use_request',
  // ADR 0081: an open plan suggestion, for whoever keeps the plans.
  'plan_suggestion',
  // ADR 0082: an open follow-up or recovery case, and a compensation
  // waiting for its decision.
  'follow_up_case',
  'recovery_case',
  'compensation',
  // ADR 0083: a transfer to approve, a closed unit's round to schedule, an
  // emergency entry's report to write.
  'ownership_transfer',
  'closed_unit_round',
  'unit_entry_report',
  // ADR 0089: a vendor's invoice, an advance or a retention's release
  // waiting for its approver.
  'vendor_invoice',
  'contract_disbursement',
  // ADR 0088: a tender past its deadline, waiting to be opened by two.
  'tender_opening',
  // ADR 0085: a custodian's cash not handed in, and a hand-in's variance
  // not yet settled.
  'cash_custody',
  'custody_variance',
  // ADR 0090: an account that looks dangling and an access review, for
  // `accounts.manage`; a reinforcement suggested by service pressure, for
  // the field team.
  'dangling_account',
  'access_review',
  'reinforcement_suggestion',
  // ADR 0092: a manual journal entry waiting for its second person.
  'gl_manual_entry',
  // ADR 0094: a purchase order waiting for its approver.
  'purchase_order',
] as const;
export type InboxType = (typeof INBOX_TYPES)[number];

/** The longest a compound may give itself to decide a type: 30 days. */
export const MAX_DUE_HOURS = 720;

/** One pending item, as its domain reads it: codes and references only. */
export interface InboxRow {
  type: InboxType;
  id: string;
  /** Its reference as the domain shows it (`V-000123`), or null. */
  number: string | null;
  /** What it is within its type (a permit's kind, a field's name), or null. */
  kind: string | null;
  /** The domain's own pending status. */
  status: string;
  unitId: string | null;
  /** When it started waiting: the queue's order and its age. */
  requestedAt: Date;
  /**
   * The amount at stake, as a decimal string, for a type with a threshold
   * (a plan's total); null when the decision sets it (a dispute's credit).
   */
  amount: string | null;
}

export interface InboxCursor {
  at: Date;
  id: string;
}

export interface InboxPageRequest {
  /** Strictly past this (requestedAt, id), oldest first. */
  after: InboxCursor | null;
  take: number;
  /** Only the ones waiting since before this instant (the overdue ones). */
  requestedBefore: Date | null;
}

export interface InboxSource {
  type: InboxType;
  /** Who sees the type and decides it: the holders of this permission. */
  permission: Permission;
  /** Hours to decide, unless the compound set its own (1–720). */
  dueHours: number;
  /** The board's threshold that applies to its amount, when one does. */
  threshold?: ThresholdType;
  /** Pending items, oldest first. */
  page(tx: TenantTxClient, q: InboxPageRequest): Promise<InboxRow[]>;
  /** How many are pending; with `requestedBefore`, how many since before it. */
  count(tx: TenantTxClient, requestedBefore: Date | null): Promise<number>;
  /**
   * The domain's own approval of one item, for a type whose approval takes
   * no input; in its own transaction, as the caller. Absent: not in bulk.
   */
  approve?: (id: string) => Promise<void>;
}

/**
 * "Strictly past the cursor" in the inbox's order (oldest first) on a
 * source's own column, as a Prisma condition.
 */
export function afterCursor<F extends string>(
  field: F,
  after: InboxCursor | null,
): object[] {
  if (!after) return [];
  return [
    {
      OR: [
        { [field]: { gt: after.at } },
        { [field]: after.at, id: { gt: after.id } },
      ],
    },
  ];
}

/** Waiting since before `before`, when given, on a source's own column. */
export function waitingSince<F extends string>(
  field: F,
  before: Date | null,
): object[] {
  return before ? [{ [field]: { lt: before } }] : [];
}

/** Oldest first, then by id: the order every source and the merge keep. */
export function byWait(a: InboxRow, b: InboxRow): number {
  return (
    a.requestedAt.getTime() - b.requestedAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** A number with the domain's prefix: `V-000123`. */
export function reference(prefix: string, n: number | null): string | null {
  return n === null ? null : `${prefix}-${String(n).padStart(6, '0')}`;
}

@Injectable()
export class StaffInbox {
  private readonly sources = new Map<InboxType, InboxSource>();

  register(source: InboxSource): void {
    if (this.sources.has(source.type))
      throw new Error(`Inbox source ${source.type} is registered twice`);
    if (source.dueHours < 1 || source.dueHours > MAX_DUE_HOURS)
      throw new Error(`Inbox source ${source.type}: dueHours out of range`);
    this.sources.set(source.type, source);
  }

  /** In INBOX_TYPES order. */
  all(): InboxSource[] {
    return INBOX_TYPES.flatMap((t) => {
      const s = this.sources.get(t);
      return s ? [s] : [];
    });
  }

  of(type: InboxType): InboxSource | null {
    return this.sources.get(type) ?? null;
  }

  /** The types no domain registered (checked at bootstrap). */
  missing(): InboxType[] {
    return INBOX_TYPES.filter((t) => !this.sources.has(t));
  }
}
