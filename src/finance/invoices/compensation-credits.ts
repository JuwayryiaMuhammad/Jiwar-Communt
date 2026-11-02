import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  CompensationCredits,
  type CompensationCredit,
  type CompensationCreditsImpl,
  type IssuedCredit,
} from '../../core/experience/compensation-credits';
import { FinanceAccess } from '../access';
import { BoardAuthority } from '../budgets/board-authority';
import { ChargeSettler } from '../charges/charge-settler';
import { formatNumber } from '../counters';
import { show, ZERO } from '../money';
import { FinanceNotices } from '../notices/finance-notices';
import { supersedeLive } from '../online/supersede';
import { allocateUnit } from '../payments/allocation';
import { disputedAmong } from './balances';
import {
  creditInvoice,
  invoiceDisputed,
  invoiceNotFound,
} from './invoices.service';

/**
 * A compensation's credit (ADR 0082): ADR 0058's compensation credit note,
 * issued on one of the unit's invoices exactly as finance's own credit does
 * (at most what credit notes may still take off it; beyond what it owes,
 * released to the unit's credit), with the compensation's failure as its
 * reason, and the unit told the code, never the amount.
 *
 * In experience's transaction, after its locks: the compound's and the
 * unit's finance locks, then the board's threshold (compensation_above_limit,
 * shared) and, above a binding one, the authorization's row (ADR 0073),
 * used once by this compensation.
 */
@Injectable()
export class FinanceCompensationCredits
  implements CompensationCreditsImpl, OnModuleInit
{
  constructor(
    private readonly port: CompensationCredits,
    private readonly ctx: RequestContext,
    private readonly access: FinanceAccess,
    private readonly authority: BoardAuthority,
    private readonly settler: ChargeSettler,
    private readonly notices: FinanceNotices,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.port.implement(this);
  }

  async credit(
    tx: TenantTxClient,
    input: CompensationCredit,
  ): Promise<IssuedCredit> {
    await this.access.lockUnits(tx, [input.unitId]);
    const invoice = await tx.invoice.findUnique({
      where: { id: input.invoiceId },
    });
    if (!invoice || invoice.unitId !== input.unitId) throw invoiceNotFound();
    // A disputed invoice is credited only by its dispute's decision.
    if ((await disputedAmong(tx, [invoice.id])).length) throw invoiceDisputed();
    await this.authority.hold(tx, {
      type: 'compensation_above_limit',
      amount: input.amount,
      authorizationId: input.authorizationId,
      use: { type: 'experience_compensation', id: input.compensationId },
    });
    const id = newId();
    const { note, released } = await creditInvoice(tx, {
      id,
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      amount: input.amount,
      reasonCode: 'compensation',
      compensationReason: input.failureCode,
      createdById: this.ctx.accountId,
    });
    await supersedeLive(tx, [invoice.unitId]);
    if (released.gt(ZERO)) {
      await allocateUnit(tx, invoice.tenantId, invoice.unitId);
      await this.settler.settle(tx, [invoice.unitId]);
    }
    const number = formatNumber('credit_note', note.number);
    await this.audit.record(tx, {
      action: 'credit_note.created',
      targetId: id,
      metadata: {
        invoiceId: invoice.id,
        unitId: invoice.unitId,
        number,
        amount: show(note.amount),
        released: show(released),
        reasonCode: 'compensation',
        compensationReason: input.failureCode,
        compensationId: input.compensationId,
      },
    });
    await this.notices.toUnit(
      tx,
      invoice.unitId,
      'compensation.granted',
      invoice.id,
      { reason: input.failureCode },
    );
    return {
      creditNoteId: id,
      number,
      authorizationId: input.authorizationId,
    };
  }
}
