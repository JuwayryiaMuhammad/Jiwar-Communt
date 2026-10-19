import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// Board matters (ADR 0055)
// ============================================================================
//
// Governance owns approval requests and appeals to the board; what a
// decision does belongs to the domain it is about. Governance imports no
// domain and nothing imports finance (ADR 0015, 0046, 0051), so the domains
// register here, in core, at startup, and governance calls what they
// registered inside its own transaction, as AccountLifecycle and
// ExportSections are used.

/** What the board is asked to approve (ADR 0055). */
export const APPROVAL_TYPES = [
  'annual_budget',
  'budget_increase',
  'major_contract',
  'exceptional_fee',
  'waiver_above_limit',
  'payment_plan_above_limit',
  'legal_escalation',
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

/**
 * The types with a per-compound threshold. `major_contract`'s is the
 * manager's limit: an expense above it needs the board (ADR 0055); the
 * others are shown when a request is raised, and enforce nothing yet.
 */
export const THRESHOLD_TYPES = [
  'major_contract',
  'exceptional_fee',
  'waiver_above_limit',
  'payment_plan_above_limit',
] as const satisfies readonly ApprovalType[];
export type ThresholdType = (typeof THRESHOLD_TYPES)[number];

/** The staff decisions an owner or a unit's primary may take to the board. */
export const BOARD_APPEAL_KINDS = [
  'vehicle_fine',
  'unit_violation',
  'booking_suspension',
  'invoice_dispute',
] as const;
export type BoardAppealKind = (typeof BOARD_APPEAL_KINDS)[number];

/**
 * A board announcement a decision publishes (an approved annual budget),
 * written by the domain in English and Arabic; governance publishes it
 * through engagement as the board's (ADR 0051).
 */
export interface BoardNoticeDraft {
  titleEn: string;
  bodyEn: string;
  titleAr: string;
  bodyAr: string;
}

/**
 * A domain's part in one approval type. Every call runs in governance's
 * transaction, after governance's own locks (ADR 0055: the matter before
 * its subject), as the acting account; it takes no account lock of its
 * own and tells nobody.
 */
export interface ApprovalKindHandler {
  /**
   * Which subject the request names: a budget, one of its lines, or none.
   * Governance refuses a request that names another.
   */
  subject: 'budget' | 'budget_line' | null;
  /**
   * At the raise: locks the subject, refuses with a coded error when it
   * cannot be put to the board, and returns the cost to record when the
   * subject fixes it (an annual budget's total), else the one given.
   */
  raise(
    tx: TenantTxClient,
    ev: { requestId: string; subjectId: string | null; cost: string | null },
  ): Promise<{ cost: string | null }>;
  /** The subject as the board reads it with the package: codes and amounts. */
  describe(tx: TenantTxClient, subjectId: string | null): Promise<unknown>;
  /**
   * At the decision. Never throws for the subject's state: what it could
   * not apply is `implemented: false`, for the manager to follow up, so no
   * vote is ever stuck.
   */
  decided(
    tx: TenantTxClient,
    ev: {
      requestId: string;
      subjectId: string | null;
      cost: string | null;
      approved: boolean;
      now: Date;
    },
  ): Promise<{ implemented: boolean; notice?: BoardNoticeDraft }>;
  /** A pending request withdrawn: the subject goes back, if it moved. */
  withdrawn(
    tx: TenantTxClient,
    ev: { requestId: string; subjectId: string | null; now: Date },
  ): Promise<void>;
}

/** Why a decision may not be taken to the board, as `params.reason`. */
export type AppealRefusal =
  | 'not_found'
  | 'not_decided'
  | 'not_against_unit'
  | 'paid'
  | 'cancelled'
  | 'not_in_force'
  | 'appealed';

/**
 * A domain's part in one kind of appeal. Same rules as approvals: in
 * governance's transaction, no account lock, no notice.
 */
export interface AppealKindHandler {
  /**
   * Locks the decision's row (or its unit's lock) and says whether it
   * stands against the unit now: its unit and when the staff decided, or
   * why not. Read again after the lock.
   */
  resolve(
    tx: TenantTxClient,
    subjectId: string,
  ): Promise<{ unitId: string; decidedAt: Date } | { refused: AppealRefusal }>;
  /** Marks the decision appealed (the domain refuses what would moot it). */
  lodged(tx: TenantTxClient, subjectId: string, now: Date): Promise<void>;
  /**
   * The appeal ended: the mark is closed, and an overturn applies the
   * domain's effect (`applied`), or leaves it to the management
   * (`follow_up`). Never throws for the subject's state.
   */
  closed(
    tx: TenantTxClient,
    subjectId: string,
    outcome: 'upheld' | 'overturned' | 'withdrawn',
    now: Date,
  ): Promise<{ effect: 'applied' | 'follow_up' | 'none' }>;
  /** The decision as the board and the appellant read it: codes, amounts, dates. */
  describe(tx: TenantTxClient, subjectId: string): Promise<unknown>;
}

/** One part of the board's overview, from a domain's existing reports. */
export type OverviewSection = (period: {
  from: string;
  to: string;
}) => Promise<Record<string, unknown>>;

/** The compound's threshold for a type now, a decimal string, or null. */
export type ThresholdReader = (
  tx: TenantTxClient,
  type: ThresholdType,
) => Promise<string | null>;

@Injectable()
export class BoardMatters {
  private readonly approvals = new Map<ApprovalType, ApprovalKindHandler>();
  private readonly appeals = new Map<BoardAppealKind, AppealKindHandler>();
  private readonly sections = new Map<string, OverviewSection>();
  private thresholds: ThresholdReader | null = null;

  registerApproval(type: ApprovalType, handler: ApprovalKindHandler): void {
    if (this.approvals.has(type))
      throw new Error(`Approval type ${type} is registered twice`);
    this.approvals.set(type, handler);
  }

  registerAppeal(kind: BoardAppealKind, handler: AppealKindHandler): void {
    if (this.appeals.has(kind))
      throw new Error(`Board appeal kind ${kind} is registered twice`);
    this.appeals.set(kind, handler);
  }

  registerOverview(name: string, section: OverviewSection): void {
    if (this.sections.has(name))
      throw new Error(`Overview section ${name} is registered twice`);
    this.sections.set(name, section);
  }

  /** Governance's settings: the thresholds (one reader). */
  registerThresholds(reader: ThresholdReader): void {
    if (this.thresholds) throw new Error('Thresholds are registered twice');
    this.thresholds = reader;
  }

  /** The type's handler, or null for a type whose decision does nothing itself. */
  approval(type: ApprovalType): ApprovalKindHandler | null {
    return this.approvals.get(type) ?? null;
  }

  appeal(kind: BoardAppealKind): AppealKindHandler | null {
    return this.appeals.get(kind) ?? null;
  }

  /** In registration order. */
  overview(): [string, OverviewSection][] {
    return [...this.sections.entries()];
  }

  threshold(tx: TenantTxClient, type: ThresholdType): Promise<string | null> {
    if (!this.thresholds) throw new Error('No thresholds are registered');
    return this.thresholds(tx, type);
  }

  /** What is missing of `approvals` and `appeals` (governance checks it at bootstrap). */
  missing(want: {
    approvals: readonly ApprovalType[];
    appeals: readonly BoardAppealKind[];
  }): string[] {
    return [
      ...want.approvals
        .filter((t) => !this.approvals.has(t))
        .map((t) => `approval:${t}`),
      ...want.appeals
        .filter((k) => !this.appeals.has(k))
        .map((k) => `appeal:${k}`),
    ];
  }
}
