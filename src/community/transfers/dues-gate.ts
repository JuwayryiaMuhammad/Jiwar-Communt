import { Injectable } from '@nestjs/common';
import { StepUpService } from '../../core/auth/step-up.service';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { UnitDues } from '../../core/unit-dues/unit-dues';

/** What the dues gate read, and the exception given when the unit owed. */
export interface DuesGateOutcome {
  /** What the unit owed when the transfer went ahead, "0.00" when nothing. */
  owed: string;
  /** REASON_CODES.transferDuesException, only when the unit owed. */
  exception: string | null;
}

/**
 * The dues gate of an ownership transfer (ADR 0083). A unit that owes the
 * compound does not change hands: TRANSFER_DUES_OWED with the amount. The
 * management may still let it go ahead as an exception — a code from
 * `REASON_CODES.transferDuesException` and a fresh step-up (ADR 0036),
 * spent in the transfer's own transaction, so a refused or rolled-back
 * transfer leaves it usable — and it is audited with what was owed.
 *
 * The amount is finance's (UnitDues: the clearance's computation), read
 * under finance's own lock on the unit, last in the transfer's lock order
 * (accounts, the unit, the transfer's row, then this): a payment or an
 * invoice landing at that moment is either counted or waits for the
 * transfer to commit.
 */
@Injectable()
export class TransferDuesGate {
  constructor(
    private readonly dues: UnitDues,
    private readonly stepUp: StepUpService,
  ) {}

  /** The exception's code checked before any work; undefined: none given. */
  exceptionCode(code: string | undefined): string | null {
    return code === undefined
      ? null
      : requireReasonCodeOnly(code, REASON_CODES.transferDuesException);
  }

  async pass(
    tx: TenantTxClient,
    unitId: string,
    exception: string | null,
  ): Promise<DuesGateOutcome> {
    const owed = await this.dues.lockAndRead(tx, unitId);
    if (!UnitDues.owes(owed)) return { owed, exception: null };
    if (exception === null)
      throw appError.conflict(
        ErrorCode.TRANSFER_DUES_OWED,
        'The unit owes the compound',
        { params: { owed } },
      );
    await this.stepUp.consume(tx);
    return { owed, exception };
  }
}
