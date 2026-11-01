import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FinanceBoardAuthorization, Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import {
  BINDABLE_TYPES,
  BoardMatters,
  type BindableType,
} from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { money, show } from '../money';

/** What an authorization served: one dispute's credit, or one plan. */
export type AuthorizationUse = {
  type: 'invoice_dispute' | 'plan_request' | 'invoice';
  id: string;
};

export interface BoardAuthorizationRead {
  id: string;
  approvalRequestId: string;
  type: BindableType;
  amount: string;
  createdAt: Date;
  usedAt: Date | null;
  usedBy: AuthorizationUse | null;
}

export function readAuthorization(
  r: FinanceBoardAuthorization,
): BoardAuthorizationRead {
  return {
    id: r.id,
    approvalRequestId: r.approvalRequestId,
    type: r.type as BindableType,
    amount: show(r.amount),
    createdAt: r.createdAt,
    usedAt: r.usedAt,
    usedBy:
      r.usedByType && r.usedById
        ? {
            type: r.usedByType as AuthorizationUse['type'],
            id: r.usedById,
          }
        : null,
  };
}

/**
 * The board's authority over a waiver and a payment plan, binding (ADR
 * 0073). ADR 0055's thresholds for them were advisory; when the compound
 * makes one binding, an amount above it is refused (`NEEDS_BOARD_APPROVAL`)
 * unless it names an authorization: what an approved request of the type
 * granted, of its cost, used once. The threshold's row is read shared and
 * the authorization's row locked, after the caller's own locks.
 */
@Injectable()
export class BoardAuthority implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    for (const type of BINDABLE_TYPES)
      this.matters.registerApproval(type, {
        subject: null,
        raise: (_tx, ev) => Promise.resolve({ cost: ev.cost }),
        describe: () => Promise.resolve(null),
        decided: async (tx, ev) => {
          if (!ev.approved || !ev.cost) return { implemented: false };
          const id = newId();
          await tx.financeBoardAuthorization.create({
            data: {
              id,
              tenantId: this.ctx.txTenantId,
              approvalRequestId: ev.requestId,
              type,
              amount: ev.cost,
              createdAt: ev.now,
            },
          });
          await this.audit.record(tx, {
            action: 'board_authorization.granted',
            targetId: id,
            metadata: { requestId: ev.requestId, type, amount: ev.cost },
          });
          // Carried out by the credit or the plan that uses it.
          return { implemented: false };
        },
        withdrawn: () => Promise.resolve(),
      });
  }

  /**
   * Holds `amount` to the type's threshold. Within it, or with the
   * threshold advisory or unset, nothing is needed (and `authorizationId`
   * is FIELD_NOT_ALLOWED). Above it, the authorization is required, of the
   * type, unused and at least the amount; it is used now, by `use`.
   */
  async hold(
    tx: TenantTxClient,
    input: {
      type: BindableType;
      amount: Prisma.Decimal;
      authorizationId?: string | null;
      use: AuthorizationUse;
    },
  ): Promise<void> {
    const limit = await this.matters.threshold(tx, input.type);
    const binding = await this.matters.binding(tx, input.type);
    const above = binding && limit !== null && input.amount.gt(money(limit));
    if (!above) {
      if (input.authorizationId)
        throw invalid([
          { field: 'authorizationId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
        ]);
      return;
    }
    if (!input.authorizationId)
      throw appError.conflict(
        ErrorCode.NEEDS_BOARD_APPROVAL,
        'Above the board’s threshold: name what the board approved for it',
        { params: { type: input.type, limit } },
      );
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM finance_board_authorizations
       WHERE id = ${input.authorizationId}::uuid FOR UPDATE`;
    const auth = row
      ? await tx.financeBoardAuthorization.findUniqueOrThrow({
          where: { id: row.id },
        })
      : null;
    if (!auth || auth.type !== input.type)
      throw appError.notFound(
        ErrorCode.BOARD_AUTHORIZATION_NOT_FOUND,
        'No such authorization of this type',
      );
    if (auth.usedAt)
      throw appError.conflict(
        ErrorCode.BOARD_AUTHORIZATION_USED,
        'The authorization was used already',
      );
    if (input.amount.gt(auth.amount))
      throw appError.conflict(
        ErrorCode.BOARD_AUTHORIZATION_EXCEEDED,
        'More than the board approved',
        { params: { amount: show(auth.amount) } },
      );
    const now = await dbNow(tx);
    await tx.financeBoardAuthorization.update({
      where: { id: auth.id },
      data: {
        usedAt: now,
        usedByType: input.use.type,
        usedById: input.use.id,
        usedByAccountId: this.ctx.accountId,
      },
    });
    await this.audit.record(tx, {
      action: 'board_authorization.used',
      targetId: auth.id,
      metadata: {
        type: input.type,
        amount: show(input.amount),
        usedByType: input.use.type,
        usedById: input.use.id,
      },
    });
  }

  /** The compound's authorizations, newest first; `unused` only those still open. */
  async list(
    tx: TenantTxClient,
    q: { type?: BindableType; unused?: boolean },
  ): Promise<BoardAuthorizationRead[]> {
    const rows = await tx.financeBoardAuthorization.findMany({
      where: {
        ...(q.type ? { type: q.type } : {}),
        ...(q.unused ? { usedAt: null } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return rows.map(readAuthorization);
  }
}
