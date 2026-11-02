import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { WarrantyClaim } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { ofDateColumnOrNull } from '../schedules/local-dates';
import { ticketNotFound } from '../tickets/ticket-access';

export const WARRANTY_CLAIM_STATUSES = [
  'open',
  'accepted',
  'rejected',
  'withdrawn',
] as const;
export type WarrantyClaimStatus = (typeof WARRANTY_CLAIM_STATUSES)[number];
export const CLAIM_DESCRIPTION = { min: 1, max: 1000 };
export const CLAIM_REFERENCE = { min: 1, max: 80 };
export const WARRANTY_CLAIM_RESOURCE = 'warranty_claim';

const PAGE = keysetCursor('openedAt');

const DECIDED = {
  accepted: 'warranty_claim.accepted',
  rejected: 'warranty_claim.rejected',
  withdrawn: 'warranty_claim.withdrawn',
} as const;

export const warrantyClaimNotFound = () =>
  appError.notFound(
    ErrorCode.WARRANTY_CLAIM_NOT_FOUND,
    'Warranty claim not found',
  );

/**
 * Claims under an asset's warranty (ADR 0076), the management's
 * (`assets.manage`). A claim is made while the warranty runs (started, not
 * ended, by the compound's day); it names the asset and, if it came of
 * one, the asset's ticket, at most one open claim per ticket (the ticket's
 * row lock orders two at once; a partial unique index backs it). The
 * warrantor's reference is added while it is open; it is decided once
 * (accepted with what was recovered, rejected or withdrawn with a code),
 * under the claim's lock. Its words never reach the audit trail.
 */
@Injectable()
export class WarrantyClaimsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly calendar: CompoundCalendar,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(WARRANTY_CLAIM_RESOURCE, (id) => this.get(id));
  }

  list(q: {
    assetId?: string;
    status?: WarrantyClaimStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<WarrantyClaim>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.warrantyClaim.findMany({
        where: {
          AND: [
            q.assetId ? { assetId: q.assetId } : {},
            q.status ? { status: q.status } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<WarrantyClaim> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const claim = await tx.warrantyClaim.findUnique({ where: { id } });
      if (!claim) throw warrantyClaimNotFound();
      return claim;
    });
  }

  open(input: {
    assetId: string;
    ticketId?: string;
    description: string;
  }): Promise<WarrantyClaim> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: WARRANTY_CLAIM_RESOURCE, id });
      await tx.$queryRaw`SELECT id FROM assets WHERE id = ${input.assetId}::uuid FOR SHARE`;
      const asset = await tx.asset.findUnique({ where: { id: input.assetId } });
      if (!asset)
        throw appError.notFound(ErrorCode.ASSET_NOT_FOUND, 'Asset not found');
      const { today } = await this.calendar.now(tx);
      const starts = ofDateColumnOrNull(asset.warrantyStartsOn);
      const ends = ofDateColumnOrNull(asset.warrantyEndsOn);
      if (ends === null || (starts !== null && starts > today))
        throw appError.conflict(
          ErrorCode.ASSET_NO_WARRANTY,
          'This asset has no warranty running',
        );
      if (ends < today)
        throw appError.conflict(
          ErrorCode.WARRANTY_EXPIRED,
          'This asset’s warranty has ended',
          { params: { endsOn: ends } },
        );
      if (input.ticketId) await this.requireTicket(tx, input);
      const claim = await tx.warrantyClaim.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          assetId: input.assetId,
          ticketId: input.ticketId ?? null,
          description: input.description.trim(),
          openedById: this.ctx.accountId,
          openedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'warranty_claim.opened',
        targetId: id,
        metadata: { assetId: input.assetId, ticketId: claim.ticketId },
      });
      return claim;
    });
  }

  setReference(id: string, reference: string): Promise<WarrantyClaim> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lockOpen(tx, id);
      const after = await tx.warrantyClaim.update({
        where: { id },
        data: { reference: reference.trim() },
      });
      if (before.reference !== after.reference)
        await this.audit.record(tx, {
          action: 'warranty_claim.reference_set',
          targetId: id,
          changes: {
            reference: { from: before.reference, to: after.reference },
          },
        });
      return after;
    });
  }

  accept(id: string, recoveredAmount?: string): Promise<WarrantyClaim> {
    return this.decide(id, 'accepted', {
      recoveredAmount: recoveredAmount ?? null,
    });
  }

  reject(id: string, reasonCode?: string): Promise<WarrantyClaim> {
    return this.decide(id, 'rejected', {
      reasonCode: requireReasonCodeOnly(
        reasonCode,
        REASON_CODES.warrantyClaimReject,
      ),
    });
  }

  withdraw(id: string, reasonCode?: string): Promise<WarrantyClaim> {
    return this.decide(id, 'withdrawn', {
      reasonCode: requireReasonCodeOnly(
        reasonCode,
        REASON_CODES.warrantyClaimWithdraw,
      ),
    });
  }

  private decide(
    id: string,
    status: Exclude<WarrantyClaimStatus, 'open'>,
    with_: { reasonCode?: string; recoveredAmount?: string | null },
  ): Promise<WarrantyClaim> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockOpen(tx, id);
      const after = await tx.warrantyClaim.update({
        where: { id },
        data: {
          status,
          decidedById: this.ctx.accountId,
          decidedAt: await dbNow(tx),
          reasonCode: with_.reasonCode ?? null,
          recoveredAmount: with_.recoveredAmount ?? null,
        },
      });
      await this.audit.record(tx, {
        action: DECIDED[status],
        targetId: id,
        metadata:
          status === 'accepted'
            ? { recovered: with_.recoveredAmount !== null }
            : { reasonCode: with_.reasonCode },
      });
      return after;
    });
  }

  /** The claim under its lock, still open: WARRANTY_CLAIM_DECIDED otherwise. */
  private async lockOpen(
    tx: TenantTxClient,
    id: string,
  ): Promise<WarrantyClaim> {
    await tx.$queryRaw`SELECT id FROM warranty_claims WHERE id = ${id}::uuid FOR UPDATE`;
    const claim = await tx.warrantyClaim.findUnique({ where: { id } });
    if (!claim) throw warrantyClaimNotFound();
    if (claim.status !== 'open')
      throw appError.conflict(
        ErrorCode.WARRANTY_CLAIM_DECIDED,
        'This claim is decided already',
        { params: { status: claim.status } },
      );
    return claim;
  }

  /** The asset's own ticket, locked, with no claim open on it. */
  private async requireTicket(
    tx: TenantTxClient,
    input: { assetId: string; ticketId?: string },
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${input.ticketId}::uuid FOR UPDATE`;
    const ticket = await tx.ticket.findUnique({
      where: { id: input.ticketId },
      select: { assetId: true },
    });
    if (!ticket) throw ticketNotFound();
    if (ticket.assetId !== input.assetId)
      throw appError.conflict(
        ErrorCode.TICKET_NOT_OF_ASSET,
        'That ticket is not one of this asset’s',
      );
    const open = await tx.warrantyClaim.findFirst({
      where: { ticketId: input.ticketId, status: 'open' },
      select: { id: true },
    });
    if (open)
      throw appError.conflict(
        ErrorCode.WARRANTY_CLAIM_OPEN,
        'This ticket has an open warranty claim already',
      );
  }
}
