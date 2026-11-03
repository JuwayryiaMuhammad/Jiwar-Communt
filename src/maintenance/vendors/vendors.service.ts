import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Vendor, VendorDocument, VendorEvaluation } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
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
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { VendorDirectory } from '../../core/vendors/vendor-directory';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  dateColumn,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import {
  averageScore,
  EVALUATION_WINDOW_DAYS,
  VENDOR_DOCUMENTS_MAX,
  type EvaluationCriterion,
  type VendorCategory,
  type VendorDocumentKind,
  type VendorStatus,
} from './vendor-rules';

export const VENDOR_RESOURCE = 'vendor';

export interface VendorInput {
  name: string;
  legalName?: string;
  commercialRegister?: string;
  taxNumber?: string;
  categories?: VendorCategory[];
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  partnerId?: string;
}

export type VendorUpdate = {
  [K in keyof VendorInput]?: K extends 'name' | 'categories'
    ? VendorInput[K]
    : VendorInput[K] | null;
};

export interface VendorDocumentInput {
  kind: VendorDocumentKind;
  fileId: string;
  number?: string;
  issuedOn?: LocalDate;
  expiresOn?: LocalDate;
}

export type EvaluationInput = Record<EvaluationCriterion, number> & {
  contractId?: string;
  note?: string;
};

export interface VendorDocumentRead {
  document: VendorDocument;
  read: PresignedRead | null;
  /** Its expiry passed on the compound's today. */
  expired: boolean;
}

export interface VendorRead {
  vendor: Vendor;
  documents: VendorDocumentRead[];
  /** The last year's evaluations: how many, and their averages. */
  evaluations: {
    count: number;
    averages: ReturnType<typeof averageScore>;
  };
  /** The contracts naming it, and how many are in force today. */
  contracts: { total: number; active: number };
  /** A live paper's expiry passed. */
  documentsExpired: boolean;
}

const PAGE = keysetCursor('createdAt', 'asc');
const EVALUATIONS = keysetCursor('evaluatedAt');

export const vendorNotFound = () =>
  appError.notFound(ErrorCode.VENDOR_NOT_FOUND, 'Vendor not found');
export const vendorSuspended = () =>
  appError.conflict(ErrorCode.VENDOR_SUSPENDED, 'This vendor is suspended');
const wrongStatus = (status: string) =>
  appError.conflict(
    ErrorCode.VENDOR_WRONG_STATUS,
    'The vendor is not in a state that allows this',
    { params: { status } },
  );
const documentNotFound = () =>
  appError.notFound(ErrorCode.VENDOR_DOCUMENT_NOT_FOUND, 'Document not found');
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid vendor', {
    fields,
  });

/**
 * The compound's vendor register (ADR 0077), kept with `vendors.manage`:
 * the companies it buys from and contracts with, apart from partners (the
 * services residents use, ADR 0060), with an optional link to one. A
 * vendor's contacts are a company's business data, audited as
 * `{ changed }` all the same. One vendor a name (without case) and a
 * partner, both checked first under the name's advisory lock and kept by
 * unique indexes.
 *
 * Writes lock the vendor (`FOR UPDATE`) and decide by what they read after
 * the lock. A suspended vendor takes no new contract, expense or purchase
 * request: those writers share-lock it (`lockUsable`), so a suspension
 * waits for them or they for it. Its papers are never edited, removed
 * once; its evaluations append only.
 */
@Injectable()
export class VendorsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly idempotency: IdempotencyService,
    private readonly directory: VendorDirectory,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(VENDOR_RESOURCE, (id) => this.get(id));
    // An expense names a vendor through core (finance imports no domain).
    // A free text naming a vendor links to it, so a suspended one is
    // refused by its name too.
    this.directory.register(async (tx, by) => {
      let id: string;
      if ('vendorId' in by) id = by.vendorId;
      else {
        const found = await tx.vendor.findFirst({
          where: { name: { equals: by.name.trim(), mode: 'insensitive' } },
          select: { id: true },
        });
        if (!found) return null;
        id = found.id;
      }
      const v = await this.lockUsable(tx, id);
      return { id: v.id, name: v.name };
    });
  }

  /** In register order; `status`, `category` and a name's part narrow it. */
  list(q: {
    status?: VendorStatus;
    category?: VendorCategory;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<Vendor>> {
    const limit = clampLimit(q.limit);
    const term = q.q?.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.vendor.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.category ? { categories: { has: q.category } } : {},
            term
              ? {
                  OR: [
                    { name: { contains: term, mode: 'insensitive' as const } },
                    {
                      legalName: {
                        contains: term,
                        mode: 'insensitive' as const,
                      },
                    },
                  ],
                }
              : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<VendorRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const vendor = await tx.vendor.findUnique({ where: { id } });
      if (!vendor) throw vendorNotFound();
      return this.load(tx, vendor);
    });
  }

  create(input: VendorInput): Promise<VendorRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: VENDOR_RESOURCE, id });
        const vendor = await this.insert(tx, id, input);
        await this.audit.record(tx, {
          action: 'vendor.created',
          targetId: id,
          changes: diffChanges(null, audited(vendor), 'vendor.created'),
          metadata: { number: vendor.number },
        });
        return id;
      })
      .then((id) => this.get(id));
  }

  /**
   * The vendor a contract names by its name (ADR 0077: every contract names
   * a vendor): the compound's of that name, whatever its case, or a new one
   * (audited as created), under the name's lock. Suspended: refused.
   */
  async findOrCreate(
    tx: TenantTxClient,
    name: string,
    phone: string | null,
  ): Promise<Vendor> {
    const clean = name.trim();
    await this.lockName(tx, clean);
    const found = await tx.vendor.findFirst({
      where: { name: { equals: clean, mode: 'insensitive' } },
    });
    if (found) return this.lockUsable(tx, found.id);
    const vendor = await this.insert(
      tx,
      newId(),
      { name: clean, ...(phone ? { phone } : {}) },
      true,
    );
    await this.audit.record(tx, {
      action: 'vendor.created',
      targetId: vendor.id,
      changes: diffChanges(null, audited(vendor), 'vendor.created'),
      metadata: { number: vendor.number, via: 'contract' },
    });
    return vendor;
  }

  /** Its details; a name or a partner another vendor has is refused. */
  update(id: string, input: VendorUpdate): Promise<VendorRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const name = input.name?.trim();
        if (name) await this.lockName(tx, name);
        const before = await this.lock(tx, id);
        if (name && name.toLowerCase() !== before.name.toLowerCase())
          await this.requireFreeName(tx, name);
        if (input.partnerId && input.partnerId !== before.partnerId)
          await this.requirePartner(tx, input.partnerId);
        const vendor = await tx.vendor.update({
          where: { id },
          data: {
            name,
            legalName: text(input.legalName),
            commercialRegister: text(input.commercialRegister),
            taxNumber: text(input.taxNumber),
            categories: input.categories
              ? [...new Set(input.categories)]
              : undefined,
            contactName: text(input.contactName),
            phone: text(input.phone),
            email: text(input.email),
            address: text(input.address),
            notes: text(input.notes),
            partnerId: input.partnerId,
          },
        });
        const changes = diffChanges(
          audited(before),
          audited(vendor),
          'vendor.updated',
        );
        if (Object.keys(changes).length)
          await this.audit.record(tx, {
            action: 'vendor.updated',
            targetId: id,
            changes,
          });
      })
      .then(() => this.get(id));
  }

  /** With a code; its contracts run on, nothing new names it. */
  suspend(id: string, reasonCode?: string): Promise<VendorRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.vendorSuspend,
    );
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'active') throw wrongStatus(before.status);
        await tx.vendor.update({
          where: { id },
          data: {
            status: 'suspended',
            suspendedAt: await dbNow(tx),
            suspendedById: this.ctx.accountId,
            suspendReason: reason,
          },
        });
        await this.audit.record(tx, {
          action: 'vendor.suspended',
          targetId: id,
          metadata: { reasonCode: reason },
        });
      })
      .then(() => this.get(id));
  }

  reinstate(id: string): Promise<VendorRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'suspended') throw wrongStatus(before.status);
        await tx.vendor.update({
          where: { id },
          data: {
            status: 'active',
            suspendedAt: null,
            suspendedById: null,
            suspendReason: null,
          },
        });
        await this.audit.record(tx, {
          action: 'vendor.reinstated',
          targetId: id,
          metadata: { suspendedFor: before.suspendReason },
        });
      })
      .then(() => this.get(id));
  }

  /** A paper, at most VENDOR_DOCUMENTS_MAX live; on a suspended one too. */
  addDocument(
    vendorId: string,
    input: VendorDocumentInput,
  ): Promise<VendorDocumentRead> {
    if (input.issuedOn && input.expiresOn && input.expiresOn <= input.issuedOn)
      throw invalid([
        { field: 'expiresOn', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, vendorId);
      const live = await tx.vendorDocument.count({
        where: { vendorId, removedAt: null },
      });
      if (live >= VENDOR_DOCUMENTS_MAX)
        throw appError.conflict(
          ErrorCode.MAINTENANCE_DOCUMENT_LIMIT_REACHED,
          'No more documents here',
          { params: { max: VENDOR_DOCUMENTS_MAX } },
        );
      const file = await this.files.claim(tx, input.fileId, 'vendor_document');
      if (!file)
        throw invalid([
          { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      const id = newId();
      const document = await tx.vendorDocument.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          vendorId,
          kind: input.kind,
          fileId: file.id,
          number: input.number?.trim() || null,
          issuedOn: input.issuedOn ? dateColumn(input.issuedOn) : null,
          expiresOn: input.expiresOn ? dateColumn(input.expiresOn) : null,
          addedById: this.ctx.accountId,
          addedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'vendor.document_added',
        targetId: vendorId,
        metadata: {
          documentId: id,
          kind: input.kind,
          expiresOn: input.expiresOn ?? null,
        },
      });
      const { today } = await this.calendar.now(tx);
      return documentRead(
        document,
        await this.files.readUrl(tx, file.id),
        today,
      );
    });
  }

  /** Removed once (filed by mistake): the row stays, its file goes. */
  removeDocument(vendorId: string, documentId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, vendorId);
      await tx.$queryRaw`SELECT id FROM vendor_documents WHERE id = ${documentId}::uuid FOR UPDATE`;
      const document = await tx.vendorDocument.findUnique({
        where: { id: documentId },
      });
      if (
        !document ||
        document.vendorId !== vendorId ||
        document.removedAt !== null
      )
        throw documentNotFound();
      await tx.vendorDocument.update({
        where: { id: documentId },
        data: { removedAt: await dbNow(tx), removedById: this.ctx.accountId },
      });
      await this.files.markDeleted(
        tx,
        { id: document.fileId, purpose: 'vendor_document' },
        'withdrawn',
      );
      await this.audit.record(tx, {
        action: 'vendor.document_removed',
        targetId: vendorId,
        metadata: { documentId, kind: document.kind },
      });
    });
  }

  /**
   * Five scores and a note, for one of its contracts or in general; on a
   * suspended vendor too (its record).
   */
  evaluate(vendorId: string, input: EvaluationInput): Promise<VendorRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId}::uuid FOR SHARE`;
        const vendor = await tx.vendor.findUnique({ where: { id: vendorId } });
        if (!vendor) throw vendorNotFound();
        if (input.contractId) {
          const contract = await tx.maintenanceContract.findUnique({
            where: { id: input.contractId },
            select: { vendorId: true },
          });
          if (!contract || contract.vendorId !== vendorId)
            throw invalid([
              {
                field: 'contractId',
                code: FieldErrorCode.CONTRACT_NOT_OF_VENDOR,
              },
            ]);
        }
        const id = newId();
        await tx.vendorEvaluation.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            vendorId,
            contractId: input.contractId ?? null,
            quality: input.quality,
            timeliness: input.timeliness,
            cost: input.cost,
            communication: input.communication,
            safety: input.safety,
            note: input.note?.trim() || null,
            evaluatedById: this.ctx.accountId,
            evaluatedAt: await dbNow(tx),
          },
        });
        await this.audit.record(tx, {
          action: 'vendor.evaluated',
          targetId: vendorId,
          metadata: {
            evaluationId: id,
            contractId: input.contractId ?? null,
            quality: input.quality,
            timeliness: input.timeliness,
            cost: input.cost,
            communication: input.communication,
            safety: input.safety,
          },
          ...(input.note?.trim()
            ? { changes: { note: { changed: true } } }
            : {}),
        });
      })
      .then(() => this.get(vendorId));
  }

  /** Newest first. */
  evaluations(
    vendorId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<VendorEvaluation>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.vendor.findUnique({ where: { id: vendorId } })))
        throw vendorNotFound();
      const rows = await tx.vendorEvaluation.findMany({
        where: { AND: [{ vendorId }, ...EVALUATIONS.after(q.cursor)] },
        orderBy: EVALUATIONS.orderBy,
        take: limit + 1,
      });
      return EVALUATIONS.toPage(rows, limit);
    });
  }

  /**
   * A vendor a new contract, expense or purchase request names: shared
   * locked, so it is not suspended under the write; refused when it is.
   */
  async lockUsable(tx: TenantTxClient, id: string): Promise<Vendor> {
    await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${id}::uuid FOR SHARE`;
    const vendor = await tx.vendor.findUnique({ where: { id } });
    if (!vendor) throw vendorNotFound();
    if (vendor.status !== 'active') throw vendorSuspended();
    return vendor;
  }

  private async insert(
    tx: TenantTxClient,
    id: string,
    input: VendorInput,
    nameLocked = false,
  ): Promise<Vendor> {
    const name = input.name.trim();
    if (!nameLocked) await this.lockName(tx, name);
    await this.requireFreeName(tx, name);
    if (input.partnerId) await this.requirePartner(tx, input.partnerId);
    const number = await nextProcurementNumber(tx, this.ctx.tenantId, 'vendor');
    return tx.vendor.create({
      data: {
        id,
        tenantId: this.ctx.tenantId,
        number,
        name,
        legalName: input.legalName?.trim() || null,
        commercialRegister: input.commercialRegister?.trim() || null,
        taxNumber: input.taxNumber?.trim() || null,
        categories: input.categories?.length
          ? [...new Set(input.categories)]
          : ['other'],
        contactName: input.contactName?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        notes: input.notes?.trim() || null,
        partnerId: input.partnerId ?? null,
        createdById: this.ctx.accountId,
      },
    });
  }

  private async load(tx: TenantTxClient, vendor: Vendor): Promise<VendorRead> {
    const { today } = await this.calendar.now(tx);
    const day = dateColumn(today);
    const documents = await tx.vendorDocument.findMany({
      where: { vendorId: vendor.id, removedAt: null },
      orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
    });
    const evaluations = await tx.$queryRaw<
      Record<EvaluationCriterion, number>[]
    >`
      SELECT quality, timeliness, cost, communication, safety
        FROM vendor_evaluations
       WHERE vendor_id = ${vendor.id}::uuid
         AND evaluated_at >= clock_timestamp() - make_interval(days => ${EVALUATION_WINDOW_DAYS}::int)`;
    const total = await tx.maintenanceContract.count({
      where: { vendorId: vendor.id },
    });
    const active = await tx.maintenanceContract.count({
      where: {
        vendorId: vendor.id,
        terminatedAt: null,
        startsOn: { lte: day },
        endsOn: { gte: day },
      },
    });
    const reads: VendorDocumentRead[] = [];
    for (const d of documents)
      reads.push(
        documentRead(d, await this.files.readUrl(tx, d.fileId), today),
      );
    return {
      vendor,
      documents: reads,
      evaluations: {
        count: evaluations.length,
        averages: averageScore(evaluations),
      },
      contracts: { total, active },
      documentsExpired: reads.some((d) => d.expired),
    };
  }

  private async lock(tx: TenantTxClient, id: string): Promise<Vendor> {
    await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${id}::uuid FOR UPDATE`;
    const vendor = await tx.vendor.findUnique({ where: { id } });
    if (!vendor) throw vendorNotFound();
    return vendor;
  }

  /** One writer a name a compound, whatever its case. */
  private async lockName(tx: TenantTxClient, name: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`vendor-name:${this.ctx.txTenantId}:${name.toLowerCase()}`}))`;
  }

  private async requireFreeName(
    tx: TenantTxClient,
    name: string,
  ): Promise<void> {
    const taken = await tx.vendor.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (taken)
      throw appError.conflict(
        ErrorCode.VENDOR_NAME_TAKEN,
        'Another vendor has this name',
        { params: { vendorId: taken.id } },
      );
  }

  private async requirePartner(
    tx: TenantTxClient,
    partnerId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vendor-partner:${this.ctx.txTenantId}:${partnerId}`}))`;
    if (!(await tx.partner.findUnique({ where: { id: partnerId } })))
      throw invalid([
        { field: 'partnerId', code: FieldErrorCode.PARTNER_NOT_AVAILABLE },
      ]);
    const taken = await tx.vendor.findFirst({
      where: { partnerId },
      select: { id: true },
    });
    if (taken)
      throw appError.conflict(
        ErrorCode.VENDOR_PARTNER_TAKEN,
        'The partner is already another vendor',
        { params: { vendorId: taken.id } },
      );
  }
}

/** The next V-, PR- or TN- number, under the counter's row lock: take it last. */
export async function nextProcurementNumber(
  tx: TenantTxClient,
  tenantId: string,
  kind: 'vendor' | 'purchase_request' | 'tender',
): Promise<number> {
  const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
    INSERT INTO procurement_counters (tenant_id, kind, last_number)
    VALUES (${tenantId}::uuid, ${kind}, 1)
    ON CONFLICT (tenant_id, kind)
      DO UPDATE SET last_number = procurement_counters.last_number + 1
    RETURNING last_number AS number`;
  return number;
}

function documentRead(
  document: VendorDocument,
  read: PresignedRead | null,
  today: LocalDate,
): VendorDocumentRead {
  return {
    document,
    read,
    expired:
      document.expiresOn !== null && ofDateColumn(document.expiresOn) < today,
  };
}

/** A patch's text: undefined keeps it, null or blank clears it. */
function text(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v?.trim() || null;
}

const audited = (v: Vendor) => ({
  name: v.name,
  legalName: v.legalName,
  commercialRegister: v.commercialRegister,
  taxNumber: v.taxNumber,
  categories: [...v.categories].sort().join(','),
  contactName: v.contactName,
  phone: v.phone,
  email: v.email,
  address: v.address,
  notes: v.notes,
  partnerId: v.partnerId,
});
