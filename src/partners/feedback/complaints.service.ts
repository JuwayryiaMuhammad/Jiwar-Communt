import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PartnerComplaint } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { ManagementPartnersPort } from '../../management';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import { PartnerNotices } from '../notices/partner-notices';
import {
  requestNotFound,
  PartnerRequestEngine,
} from '../requests/request-engine';
import { PartnerSettingsService } from '../settings/partner-settings.service';
import { PartnersService } from '../setup/partners.service';
import { ComplaintView } from './views/feedback.views';

export const PARTNER_COMPLAINT_RESOURCE = 'partner_complaint';

const DAY_MS = 86_400_000;

export const COMPLAINT_OUTCOMES = ['upheld', 'not_upheld'] as const;
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];

export interface NewComplaint {
  reason: string;
  compensationAsk: string;
  requestedAmount?: string | null;
  message: string;
}

export interface ComplaintsQuery {
  decided?: boolean;
  partnerId?: string;
  cursor?: string;
  limit?: number;
}

/** A complaint with the numbers its views show. */
export interface ComplaintRead extends PartnerComplaint {
  requestNumber: number;
  managementRequestNumber: string;
  partner: { id: string; nameEn: string; nameAr: string };
}

export const complaintNotFound = () =>
  appError.notFound(
    ErrorCode.PARTNER_COMPLAINT_NOT_FOUND,
    'Partner complaint not found',
  );

const PAGE = keysetCursor('createdAt', 'desc');

/**
 * Complaints against partners (ADR 0060), through the management-request
 * path. The requester complains about one request — done, not come,
 * lapsed or cancelled by the partner — within the compound's complaint
 * days of its end, once: a management request on the system topic
 * `partner_service` is opened in the same transaction, its first message
 * the complaint's words (the conversation, the response target, the
 * escalation and the close are management's, ADR 0039), and a row here
 * holds what it asks — a reason, a compensation, an amount — and, once,
 * the management's decision (`partners.manage`). A credit note is issued
 * in finance by its own route: no money moves here.
 */
@Injectable()
export class PartnerComplaintsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly engine: PartnerRequestEngine,
    private readonly settings: PartnerSettingsService,
    private readonly management: ManagementPartnersPort,
    private readonly notices: PartnerNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PARTNER_COMPLAINT_RESOURCE, async (id) =>
      ComplaintView.from(
        await this.tenantTx.withTenantTx(
          async (tx) => (await this.read(tx, [await this.load(tx, id)]))[0],
        ),
      ),
    );
  }

  complain(requestId: string, input: NewComplaint): Promise<ComplaintRead> {
    const reason = requireReasonCodeOnly(
      input.reason,
      REASON_CODES.partnerComplaint,
    );
    const ask = (
      REASON_CODES.partnerCompensationAsk as readonly string[]
    ).includes(input.compensationAsk)
      ? input.compensationAsk
      : null;
    if (!ask)
      throw invalid([
        {
          field: 'compensationAsk',
          code: FieldErrorCode.INVALID_VALUE,
          params: { allowed: [...REASON_CODES.partnerCompensationAsk] },
        },
      ]);
    const amount = input.requestedAmount ?? null;
    if (amount !== null && ask !== 'refund' && ask !== 'damages')
      throw invalid([
        {
          field: 'requestedAmount',
          code: FieldErrorCode.PARTNER_AMOUNT_NOT_ASKED,
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: PARTNER_COMPLAINT_RESOURCE,
        id,
      });
      await this.access.lockSelf(tx);
      const found = await tx.partnerRequest.findUnique({
        where: { id: requestId },
      });
      if (!found || found.requesterId !== this.ctx.accountId)
        throw requestNotFound();
      await this.partners.lock(tx, found.partnerId, 'share');
      const request = await this.engine.lock(tx, requestId);
      const ended =
        request.status === 'done' ||
        request.status === 'partner_no_show' ||
        request.status === 'lapsed' ||
        (request.status === 'cancelled' && request.closedBy === 'partner');
      if (!ended)
        throw appError.conflict(
          ErrorCode.PARTNER_REQUEST_NOT_CLOSED,
          'Not a request to complain about',
          { params: { status: request.status } },
        );
      if (
        await tx.partnerComplaint.findUnique({
          where: {
            tenantId_requestId: { tenantId: request.tenantId, requestId },
          },
        })
      )
        throw appError.conflict(
          ErrorCode.PARTNER_COMPLAINT_EXISTS,
          'A complaint about this request exists already',
        );
      const settings = await this.settings.share(tx);
      const now = await dbNow(tx);
      if (
        now.getTime() >
        request.closedAt!.getTime() + settings.complaintDays * DAY_MS
      )
        throw appError.conflict(
          ErrorCode.PARTNER_REQUEST_WINDOW_CLOSED,
          'Too late to complain about it',
          { params: { days: settings.complaintDays } },
        );
      const opened = await this.management.openComplaint(tx, {
        authorId: this.ctx.accountId,
        unitId: request.unitId,
        body: input.message,
      });
      const complaint = await tx.partnerComplaint.create({
        data: {
          id,
          tenantId: request.tenantId,
          requestId,
          partnerId: request.partnerId,
          complainantId: this.ctx.accountId,
          managementRequestId: opened.id,
          reason,
          compensationAsk: ask,
          requestedAmount: amount === null ? null : new Prisma.Decimal(amount),
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'partner_complaint.created',
        targetId: id,
        metadata: {
          requestId,
          requestNumber: request.number,
          partnerId: request.partnerId,
          managementRequestId: opened.id,
          reason,
          compensationAsk: ask,
          requestedAmount: amount,
        },
      });
      return (await this.read(tx, [complaint]))[0];
    });
  }

  /** The caller's complaint about their request, or null. */
  async ofRequest(
    tx: TenantTxClient,
    requestIds: readonly string[],
  ): Promise<Map<string, ComplaintRead>> {
    if (!requestIds.length) return new Map();
    const rows = await tx.partnerComplaint.findMany({
      where: { requestId: { in: [...new Set(requestIds)] } },
    });
    return new Map((await this.read(tx, rows)).map((c) => [c.requestId, c]));
  }

  staffList(q: ComplaintsQuery): Promise<Page<ComplaintRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.partnerComplaint.findMany({
        where: {
          AND: [
            q.partnerId ? { partnerId: q.partnerId } : {},
            q.decided === undefined
              ? {}
              : q.decided
                ? { decidedAt: { not: null } }
                : { decidedAt: null },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.read(tx, page.items) };
    });
  }

  staffGet(id: string): Promise<ComplaintRead> {
    return this.tenantTx.withTenantTx(
      async (tx) => (await this.read(tx, [await this.load(tx, id)]))[0],
    );
  }

  /**
   * The management's decision, once, under the complaint's row lock:
   * upheld with what it arranges (a redo, the partner's refund, a credit
   * note issued in finance, or nothing), or not upheld with nothing. The
   * complainant is told by codes.
   */
  decide(
    id: string,
    input: { outcome: ComplaintOutcome; compensation: string },
  ): Promise<ComplaintRead> {
    const compensation = requireReasonCodeOnly(
      input.compensation,
      REASON_CODES.partnerCompensationDecision,
    );
    if (input.outcome === 'not_upheld' && compensation !== 'none')
      throw invalid([
        {
          field: 'compensation',
          code: FieldErrorCode.PARTNER_COMPENSATION_NOT_UPHELD,
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM partner_complaints WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows.length) throw complaintNotFound();
      const complaint = await this.load(tx, id);
      if (complaint.decidedAt)
        throw appError.conflict(
          ErrorCode.PARTNER_COMPLAINT_DECIDED,
          'The complaint was decided already',
        );
      const after = await tx.partnerComplaint.update({
        where: { id },
        data: {
          outcome: input.outcome,
          compensation,
          decidedById: this.ctx.accountId,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'partner_complaint.decided',
        targetId: id,
        metadata: {
          requestId: complaint.requestId,
          partnerId: complaint.partnerId,
          outcome: input.outcome,
          compensation,
        },
      });
      await this.notices.send(
        tx,
        [complaint.complainantId],
        'partner_complaint.decided',
        id,
        { outcome: input.outcome, compensation },
        this.ctx.accountId,
      );
      return (await this.read(tx, [after]))[0];
    });
  }

  private async load(
    tx: TenantTxClient,
    id: string,
  ): Promise<PartnerComplaint> {
    const complaint = await tx.partnerComplaint.findUnique({ where: { id } });
    if (!complaint) throw complaintNotFound();
    return complaint;
  }

  private async read(
    tx: TenantTxClient,
    rows: readonly PartnerComplaint[],
  ): Promise<ComplaintRead[]> {
    if (!rows.length) return [];
    const numbers = new Map(
      (
        await tx.partnerRequest.findMany({
          where: { id: { in: rows.map((r) => r.requestId) } },
          select: { id: true, number: true },
        })
      ).map((r) => [r.id, r.number]),
    );
    const partners = new Map(
      (
        await tx.partner.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.partnerId))] } },
          select: { id: true, nameEn: true, nameAr: true },
        })
      ).map((p) => [p.id, p]),
    );
    const management = await this.management.numbers(
      tx,
      rows.map((r) => r.managementRequestId),
    );
    return rows.map((r) => ({
      ...r,
      requestNumber: numbers.get(r.requestId) ?? 0,
      managementRequestNumber: management.get(r.managementRequestId) ?? '',
      partner: partners.get(r.partnerId)!,
    }));
  }
}
