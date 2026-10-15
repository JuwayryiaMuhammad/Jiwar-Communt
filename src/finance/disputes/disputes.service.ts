import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type InvoiceDispute } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FinanceAccess } from '../access';
import { formatNumber } from '../counters';
import { dbNow } from '../db-clock';
import { money, show, ZERO } from '../money';
import { FinanceNotices } from '../notices/finance-notices';
import { supersedeLive } from '../online/supersede';
import { allocateUnit } from '../payments/allocation';
import { balancesOf } from '../invoices/balances';
import { creditInvoice, invoiceNotFound } from '../invoices/invoices.service';
import {
  DISPUTE_TEXT,
  type DecideDisputeDto,
  type DisputeStatus,
  type OpenDisputeDto,
} from './dto/disputes.dto';
import type {
  DisputeDecisionView,
  DisputeView,
  StaffDisputeView,
} from './views/dispute.views';

export const DISPUTE_RESOURCE = 'invoice_dispute';
export const DISPUTE_DECISION_RESOURCE = 'invoice_dispute_decision';
/** How many disputes one invoice may have, in all (ADR 0048). */
export const MAX_DISPUTES_PER_INVOICE = 3;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const disputeNotFound = () =>
  appError.notFound(ErrorCode.DISPUTE_NOT_FOUND, 'Dispute not found');

export interface DisputeFilter {
  status?: DisputeStatus;
  unitId?: string;
  cursor?: string;
  limit: number;
}

const cursor = keysetCursor('createdAt');

/**
 * Invoice disputes (ADR 0048). Someone who sees a unit's money disputes one
 * of its invoices that still owes something; while open, the invoice is
 * frozen (reminders, automatic allocation, payments and credit notes naming
 * it wait). The staff accept it with a credit note (at most what is owed
 * when they decide) or reject it with a reason, once. Every write holds the
 * unit's finance lock, so a decision and a payment never decide on one
 * balance at once.
 */
@Injectable()
export class DisputesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityFinancePort,
    private readonly access: FinanceAccess,
    private readonly notices: FinanceNotices,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    // An open replays as the resident's view, a decision as the staff's.
    this.idempotency.renderer(DISPUTE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.view(
          tx,
          await tx.invoiceDispute.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.idempotency.renderer(DISPUTE_DECISION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.staffView(
          tx,
          await tx.invoiceDispute.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /** A resident who sees the unit's money disputes one of its invoices. */
  open(invoiceId: string, dto: OpenDisputeDto): Promise<DisputeView> {
    const reasonCode = requireReasonCodeOnly(
      dto.reasonCode,
      REASON_CODES.invoiceDispute,
    );
    const text = dto.text?.trim();
    if (dto.text !== undefined && !text)
      throw invalid([
        {
          field: 'text',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...DISPUTE_TEXT },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: DISPUTE_RESOURCE, id });
      await this.access.lockSelf(tx);
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw invoiceNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        invoice.unitId,
      );
      if (!caps?.financeView) throw invoiceNotFound();
      await this.access.lockUnits(tx, [invoice.unitId]);
      const balance = (await balancesOf(tx, [invoiceId])).get(invoiceId)!;
      if (balance.outstanding.lte(ZERO))
        throw appError.conflict(
          ErrorCode.INVOICE_NOT_DISPUTABLE,
          'Nothing is owed on this invoice',
        );
      const earlier = await tx.invoiceDispute.findMany({
        where: { invoiceId },
        select: { status: true },
      });
      if (earlier.some((d) => d.status === 'open'))
        throw appError.conflict(
          ErrorCode.DISPUTE_ALREADY_OPEN,
          'The invoice has an open dispute',
        );
      if (earlier.length >= MAX_DISPUTES_PER_INVOICE)
        throw appError.conflict(
          ErrorCode.DISPUTE_LIMIT_REACHED,
          'The invoice was disputed too many times',
          { params: { max: MAX_DISPUTES_PER_INVOICE } },
        );
      let photoFileId: string | null = null;
      if (dto.photoFileId) {
        const file = await this.files.claim(
          tx,
          dto.photoFileId,
          'dispute_photo',
        );
        if (!file)
          throw invalid([
            {
              field: 'photoFileId',
              code: FieldErrorCode.FILE_NOT_AVAILABLE,
            },
          ]);
        await this.files.attach(tx, file);
        photoFileId = file.id;
      }
      const dispute = await tx.invoiceDispute.create({
        data: {
          id,
          tenantId: invoice.tenantId,
          invoiceId,
          unitId: invoice.unitId,
          openedById: this.ctx.accountId,
          reasonCode,
          text: text ?? null,
          photoFileId,
        },
      });
      // A live checkout may name the invoice: it must not pay what is
      // contested (a late success still lands; staff then reject with
      // `no_longer_owed`).
      await supersedeLive(tx, [invoice.unitId]);
      await this.audit.record(tx, {
        action: 'invoice_dispute.opened',
        targetId: id,
        metadata: {
          unitId: invoice.unitId,
          invoiceId,
          reasonCode,
          photo: photoFileId !== null,
        },
      });
      return this.view(tx, dispute);
    });
  }

  /**
   * The staff decide, once: accept with a credit note (at most what credit
   * notes may still take; beyond what is owed now, paid money is released
   * to the unit's credit, ADR 0048), or reject with a reason. The opener is
   * told, while they still see the money.
   */
  decide(id: string, dto: DecideDisputeDto): Promise<StaffDisputeView> {
    const shape: FieldError[] = [];
    const want = (field: 'amount' | 'reasonCode', needed: boolean) => {
      if (needed && dto[field] === undefined)
        shape.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
      if (!needed && dto[field] !== undefined)
        shape.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
    };
    want('amount', dto.decision === 'accept');
    want('reasonCode', dto.decision === 'reject');
    if (shape.length) throw invalid(shape);
    const reasonCode =
      dto.decision === 'reject'
        ? requireReasonCodeOnly(
            dto.reasonCode,
            REASON_CODES.invoiceDisputeReject,
          )
        : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, { type: DISPUTE_DECISION_RESOURCE, id });
      await this.access.lockSelf(tx);
      const found = await tx.invoiceDispute.findUnique({ where: { id } });
      if (!found) throw disputeNotFound();
      await this.access.lockUnits(tx, [found.unitId]);
      await tx.$queryRaw`
        SELECT id FROM invoice_disputes WHERE id = ${id}::uuid FOR UPDATE`;
      const dispute = await tx.invoiceDispute.findUniqueOrThrow({
        where: { id },
      });
      if (dispute.status !== 'open')
        throw appError.conflict(
          ErrorCode.DISPUTE_ALREADY_DECIDED,
          'The dispute was decided already',
          { params: { status: dispute.status } },
        );
      const tenantId = dispute.tenantId;
      const now = await dbNow(tx);
      let creditNote: {
        id: string;
        amount: Prisma.Decimal;
        released: Prisma.Decimal;
      } | null = null;
      if (dto.decision === 'accept') {
        // Up to what credit notes may still take: beyond what is owed (a
        // payment landed meanwhile), paid money is released to credit.
        const { note, released } = await creditInvoice(tx, {
          id: newId(),
          tenantId,
          invoiceId: dispute.invoiceId,
          amount: money(dto.amount!),
          reasonCode: 'dispute',
          disputeId: id,
          createdById: this.ctx.accountId,
        });
        creditNote = { id: note.id, amount: note.amount, released };
        await supersedeLive(tx, [dispute.unitId]);
      }
      const decided = await tx.invoiceDispute.update({
        where: { id },
        data: {
          status: dto.decision === 'accept' ? 'accepted' : 'rejected',
          decidedById: this.ctx.accountId,
          decidedAt: now,
          decisionReasonCode: reasonCode,
        },
      });
      // What was held back from the invoice (the unit's credit) pays what
      // is left of it now.
      await allocateUnit(tx, tenantId, dispute.unitId);
      await this.audit.record(tx, {
        action: 'invoice_dispute.decided',
        targetId: id,
        metadata: {
          unitId: dispute.unitId,
          invoiceId: dispute.invoiceId,
          decision: dto.decision,
          ...(creditNote
            ? {
                amount: show(creditNote.amount),
                released: show(creditNote.released),
                creditNoteId: creditNote.id,
              }
            : { reasonCode: reasonCode! }),
        },
      });
      await this.notices.toHolder(
        tx,
        dispute.openedById,
        dispute.unitId,
        dto.decision === 'accept'
          ? 'invoice.dispute_accepted'
          : 'invoice.dispute_rejected',
        id,
      );
      return this.staffView(tx, decided);
    });
  }

  /**
   * The opener is erased (ADR 0048): their words and photo go; the dispute
   * stays, with its code, and the staff still decide an open one.
   */
  async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM invoice_disputes
       WHERE opened_by_account_id = ${accountId}::uuid AND text_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const disputes = await tx.invoiceDispute.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: { id: true, photoFileId: true },
    });
    const now = await dbNow(tx);
    for (const d of disputes) {
      await tx.invoiceDispute.update({
        where: { id: d.id },
        data: { text: null, photoFileId: null, textClearedAt: now },
      });
      if (d.photoFileId)
        await this.files.markDeleted(
          tx,
          { id: d.photoFileId, purpose: 'dispute_photo' },
          'erasure',
        );
    }
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** The staff's list, newest first. */
  list(filter: DisputeFilter): Promise<Page<StaffDisputeView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.invoiceDispute.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.unitId ? { unitId: filter.unitId } : {}),
          AND: cursor.after(filter.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
      });
      const page = cursor.toPage(rows, filter.limit);
      const items: StaffDisputeView[] = [];
      for (const d of page.items) items.push(await this.staffView(tx, d));
      return { items, nextCursor: page.nextCursor };
    });
  }

  detail(id: string): Promise<StaffDisputeView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const d = await tx.invoiceDispute.findUnique({ where: { id } });
      if (!d) throw disputeNotFound();
      return this.staffView(tx, d);
    });
  }

  /** An invoice's disputes, for someone who sees its unit's money. */
  forInvoice(invoiceId: string): Promise<DisputeView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { unitId: true },
      });
      if (!invoice) throw invoiceNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        invoice.unitId,
      );
      if (!caps?.financeView) throw invoiceNotFound();
      const rows = await tx.invoiceDispute.findMany({
        where: { invoiceId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const views: DisputeView[] = [];
      for (const d of rows) views.push(await this.view(tx, d));
      return views;
    });
  }

  /** One dispute, for someone who sees its unit's money; else not found. */
  mine(id: string): Promise<DisputeView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const d = await tx.invoiceDispute.findUnique({ where: { id } });
      if (!d) throw disputeNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        d.unitId,
      );
      if (!caps?.financeView) throw disputeNotFound();
      return this.view(tx, d);
    });
  }

  private async decision(
    tx: TenantTxClient,
    d: InvoiceDispute,
  ): Promise<DisputeDecisionView | null> {
    if (!d.decidedAt) return null;
    const note = await tx.creditNote.findFirst({
      where: { disputeId: d.id },
      select: { id: true, number: true, amount: true },
    });
    return {
      decidedAt: d.decidedAt,
      reasonCode: d.decisionReasonCode,
      creditedAmount: note ? show(note.amount) : null,
      creditNoteId: note?.id ?? null,
      creditNoteNumber: note ? formatNumber('credit_note', note.number) : null,
    };
  }

  private async invoiceNumber(
    tx: TenantTxClient,
    invoiceId: string,
  ): Promise<string> {
    const { number } = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { number: true },
    });
    return formatNumber('invoice', number);
  }

  /** The resident's view: the words and photo to their opener only. */
  private async view(
    tx: TenantTxClient,
    d: InvoiceDispute,
  ): Promise<DisputeView> {
    const mine = d.openedById === this.ctx.accountId;
    return {
      id: d.id,
      invoiceId: d.invoiceId,
      invoiceNumber: await this.invoiceNumber(tx, d.invoiceId),
      unitId: d.unitId,
      reasonCode: d.reasonCode,
      text: mine ? d.text : null,
      photoUrl: mine
        ? ((await this.files.readUrl(tx, d.photoFileId))?.url ?? null)
        : null,
      mine,
      status: d.status,
      decision: await this.decision(tx, d),
      createdAt: d.createdAt,
    };
  }

  private async staffView(
    tx: TenantTxClient,
    d: InvoiceDispute,
  ): Promise<StaffDisputeView> {
    const units = await this.community.units(tx, [d.unitId]);
    const balance = (await balancesOf(tx, [d.invoiceId])).get(d.invoiceId)!;
    return {
      id: d.id,
      invoiceId: d.invoiceId,
      invoiceNumber: await this.invoiceNumber(tx, d.invoiceId),
      unitId: d.unitId,
      unitCode: units.get(d.unitId)?.code ?? '',
      reasonCode: d.reasonCode,
      text: d.text,
      photoUrl: (await this.files.readUrl(tx, d.photoFileId))?.url ?? null,
      cleared: d.textClearedAt !== null,
      outstanding: show(balance.outstanding),
      status: d.status,
      decision: await this.decision(tx, d),
      createdAt: d.createdAt,
    };
  }
}
