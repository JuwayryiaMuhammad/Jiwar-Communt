import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// Decision appeals (ADR 0059)
// ============================================================================
//
// A resident appeals a staff decision about their unit to the management
// (a manager who did not take it decides): a rejected permit, a rejected
// vehicle, a rejected worker, a neighbour notice. Management owns the
// appeal; what an overturn does belongs to the decision's domain, and the
// management imports neither the gate nor neighbours (ADR 0015), so the
// domains register here, in core, at startup, as with BoardMatters.

/** The staff decisions a resident may appeal to the management. */
export const DECISION_APPEAL_KINDS = [
  'permit_rejection',
  'vehicle_rejection',
  'worker_rejection',
  'neighbour_notice',
] as const;
export type DecisionAppealKind = (typeof DECISION_APPEAL_KINDS)[number];

/** Why a decision may not be appealed now, as `params.reason`. */
export type DecisionAppealRefusal = 'not_decided' | 'not_in_force' | 'appealed';

/**
 * Why an overturn was left to the management to follow up (or did
 * nothing), as the appeal records it. A code, never words.
 */
export const DECISION_APPEAL_EFFECT_REASONS = [
  // The permit: its window passed, its data purged, its requester may no
  // longer ask, the unit's live permits are at the limit, the compound's
  // work days or hours refuse it, a plate on it is blocklisted.
  'window_passed',
  'purged',
  'requester_gone',
  'unit_limit',
  'work_rules',
  'blocklisted',
  // The vehicle: no sticker was given, its registrant may no longer keep
  // vehicles, its plate is active on another, the permit's date is out of
  // range, the sticker was issued before; or it changed since (none).
  'needs_sticker',
  'registrant_gone',
  'plate_active',
  'permit_date',
  'sticker_used',
  'changed',
  // The worker: an approval needs a person (identity, birth date).
  'needs_review',
] as const;
export type DecisionAppealEffectReason =
  (typeof DECISION_APPEAL_EFFECT_REASONS)[number];

/** What an overturn did: applied, left to a person, or nothing. */
export interface DecisionAppealEffect {
  effect: 'applied' | 'follow_up' | 'none';
  reason?: DecisionAppealEffectReason;
}

/**
 * What the deciding manager adds to an overturn, for a domain whose normal
 * approval needs it: a vehicle's sticker and permit date. Without it the
 * domain leaves the overturn to the management (`needs_sticker`).
 */
export interface OverturnInput {
  stickerNumber?: string;
  permitValidUntil?: string;
}

/**
 * A domain's part in one kind. Every call runs in the management's
 * transaction, after its account locks (ADR 0059: the accounts, then the
 * appeal, then its subject); it takes no account lock and tells nobody.
 */
export interface DecisionAppealHandler {
  /**
   * Locks the decision's row (and what its writers lock first), reads it
   * again, and says: its unit, when and by whom it was decided, whether
   * `accountId` may appeal it (the domain's own rule: a permit's primary,
   * a vehicle's keepers, a worker's employer side, a notice's recipients),
   * and why it may not be appealed now. Null when there is no such
   * decision, or the account may not even see it.
   */
  resolve(
    tx: TenantTxClient,
    subjectId: string,
    accountId: string,
  ): Promise<{
    unitId: string;
    decidedAt: Date | null;
    deciderId: string | null;
    mayAppeal: boolean;
    refused: DecisionAppealRefusal | null;
  } | null>;
  /** Marks the decision appealed (its sweeps leave it while marked). */
  lodged(tx: TenantTxClient, subjectId: string, now: Date): Promise<void>;
  /**
   * The appeal ended: the mark closes, and an overturn runs the domain's
   * normal approval, with every check it makes, as `decidedById`; what any
   * check refuses is `follow_up` with its reason, never a forced approval.
   * Never throws for the subject's state.
   */
  closed(
    tx: TenantTxClient,
    subjectId: string,
    outcome: 'upheld' | 'overturned' | 'withdrawn',
    ev: {
      now: Date;
      /** The manager (null when the board overturned it). */
      decidedById: string | null;
      /** The decision's time as the appeal recorded it at the lodge. */
      decisionAt: Date;
      /** The appeal, for the domain's audit of what it applied. */
      appealId: string;
      overturn?: OverturnInput;
    },
  ): Promise<DecisionAppealEffect>;
  /** The decision as the appellant and the decider read it: codes, dates. */
  describe(tx: TenantTxClient, subjectId: string): Promise<unknown>;
}

@Injectable()
export class DecisionAppeals {
  private readonly handlers = new Map<
    DecisionAppealKind,
    DecisionAppealHandler
  >();

  register(kind: DecisionAppealKind, handler: DecisionAppealHandler): void {
    if (this.handlers.has(kind))
      throw new Error(`Decision appeal kind ${kind} is registered twice`);
    this.handlers.set(kind, handler);
  }

  handler(kind: DecisionAppealKind): DecisionAppealHandler | null {
    return this.handlers.get(kind) ?? null;
  }

  /** The kinds with no handler (the management checks it at bootstrap). */
  missing(): DecisionAppealKind[] {
    return DECISION_APPEAL_KINDS.filter((k) => !this.handlers.has(k));
  }
}
