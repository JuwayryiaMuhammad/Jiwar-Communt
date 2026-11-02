import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantTxClient } from '../database/tenant-tx.service';

// ============================================================================
// Compensation credits (ADR 0082)
// ============================================================================
//
// A compensation that is money is a credit note through finance, ADR 0058's
// `compensation` with its reason, never a ledger of its own. Nothing imports
// finance (ADR 0015, 0046), so finance implements this port at startup, as it
// does Charges, and the experience service calls it inside its own
// transaction, after its own locks (the caller's account, the case, the
// compensation): finance then takes the compound's and the unit's finance
// locks, and last the board's authorization's row (ADR 0073's order).

export interface CompensationCredit {
  /** The compensation it serves: the authorization's use, the audit's link. */
  compensationId: string;
  unitId: string;
  /** One of the unit's invoices, not under an open dispute. */
  invoiceId: string;
  amount: Prisma.Decimal;
  /** REASON_CODES.creditNoteCompensation. */
  failureCode: string;
  /**
   * What the board approved for it (`compensation_above_limit`), above the
   * binding threshold; refused within it (FIELD_NOT_ALLOWED).
   */
  authorizationId: string | null;
}

export interface IssuedCredit {
  creditNoteId: string;
  /** `CN-000123`. */
  number: string;
  /** The authorization it used, when above the threshold. */
  authorizationId: string | null;
}

export interface CompensationCreditsImpl {
  /**
   * Issues the credit note as finance's own credit does (the unit told
   * `compensation.granted`, the code and never the amount), holding it to
   * the board's threshold first: NEEDS_BOARD_APPROVAL above a binding one
   * without an authorization, and ADR 0073's other refusals.
   */
  credit(tx: TenantTxClient, input: CompensationCredit): Promise<IssuedCredit>;
}

@Injectable()
export class CompensationCredits {
  private impl: CompensationCreditsImpl | null = null;

  /** Finance, at startup: once. */
  implement(impl: CompensationCreditsImpl): void {
    if (this.impl) throw new Error('CompensationCredits is implemented twice');
    this.impl = impl;
  }

  credit(tx: TenantTxClient, input: CompensationCredit): Promise<IssuedCredit> {
    return this.need().credit(tx, input);
  }

  private need(): CompensationCreditsImpl {
    if (!this.impl)
      throw new Error(
        'CompensationCredits: finance has not implemented the port',
      );
    return this.impl;
  }
}
