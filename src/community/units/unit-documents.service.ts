import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma, UnitDocument } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { HouseholdAuthority } from '../households/household-authority';
import { lockUnits } from './unit-lock';

export const UNIT_DOCUMENT_KINDS = [
  'warranty',
  'manual',
  'handover_report',
  'utility',
  'insurance',
  'capacity_proof',
  'inspection_report',
  'other',
] as const;
export type UnitDocumentKind = (typeof UNIT_DOCUMENT_KINDS)[number];
/** What a resident or the management may add (a proof comes from registration). */
export const ADDABLE_KINDS = UNIT_DOCUMENT_KINDS.filter(
  (k) => k !== 'capacity_proof',
);
export const UNIT_DOCUMENT_VISIBILITIES = [
  'private',
  'owners',
  'occupants',
] as const;
export type UnitDocumentVisibility =
  (typeof UNIT_DOCUMENT_VISIBILITIES)[number];

/** Live documents a unit holds at most. */
export const UNIT_DOCUMENT_LIMIT = 50;
/** A warranty's holders are told this many days before it ends. */
export const WARRANTY_NOTICE_DAYS = 30;
/** An ended occupancy's documents go this long after the handover (or the end). */
export const UNIT_DOCUMENT_RETENTION_DAYS = 90;
export const WARRANTY_SWEEP = 'unit_documents.warranty_expiry';
export const UNIT_DOCUMENT_RETENTION_SWEEP = 'unit_documents.retention';

export interface UnitDocumentRead {
  id: string;
  unitId: string;
  kind: UnitDocumentKind;
  title: string;
  visibility: UnitDocumentVisibility;
  /** Whose: `unit` (the management's) or `occupancy` (a resident's). */
  holder: 'unit' | 'occupancy';
  /** Whether the caller may delete it. */
  mine: boolean;
  expiresOn: Date | null;
  createdAt: Date;
}

export interface NewUnitDocument {
  fileId: string;
  kind: string;
  title: string;
  visibility: string;
  /** A warranty's end date (`YYYY-MM-DD`), required for a warranty only. */
  expiresOn?: string;
}

/** Who the caller is on the unit, as the vault reads it. */
interface Seat {
  /** The caller's active occupancy, with its type. */
  active: { id: string; owner: boolean } | null;
  /** Occupancies of the caller's that ended: their own documents stay theirs. */
  ended: string[];
  /** A `documents` delegate: the primary's active occupancy they act for. */
  delegateFor: string | null;
}

const notFound = () =>
  appError.notFound(ErrorCode.UNIT_DOCUMENT_NOT_FOUND, 'Document not found');
const notAllowed = (message: string) =>
  appError.forbidden(ErrorCode.UNIT_DOCUMENT_NOT_ALLOWED, message);

/**
 * A unit's document vault (ADR 0062). A resident with an active occupancy
 * keeps documents for themselves (`private`), for the unit's owners, or
 * for everyone living there (`occupants`); the management adds the unit's
 * own (a handover report, the developer's warranties), never private, and
 * sees only those and the registrants' proofs of capacity — never a
 * resident's own upload. A `documents` delegate reads and adds at the
 * occupants' level for the primary. Contracts are not here (they have
 * their own record and rules).
 *
 * A document of an occupancy that ended is that occupancy's alone; it goes
 * UNIT_DOCUMENT_RETENTION_DAYS after the handover (or the end), and at
 * once when the account is erased. A warranty's holders are told
 * WARRANTY_NOTICE_DAYS before it ends, once.
 */
@Injectable()
export class UnitDocumentsService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
    private readonly lifecycle: AccountLifecycle,
    private readonly authority: HouseholdAuthority,
  ) {}

  onModuleInit(): void {
    this.sweep.register(WARRANTY_SWEEP, (now) => this.warranties(now));
    this.sweep.register(UNIT_DOCUMENT_RETENTION_SWEEP, (now) =>
      this.retain(now),
    );
    // An erased account's occupancies' documents go at once.
    this.lifecycle.onErasing(async (tx, account) => {
      const docs = await tx.unitDocument.findMany({
        where: { deletedAt: null, ownerOccupancy: { accountId: account.id } },
      });
      const now = await dbNow(tx);
      for (const doc of docs) await this.drop(tx, doc, 'erasure', now);
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The residents' side
  // --------------------------------------------------------------------------

  async list(unitId: string): Promise<UnitDocumentRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const seat = await this.seat(tx, unitId);
      const rows = await tx.unitDocument.findMany({
        where: { unitId, deletedAt: null, OR: visibleTo(seat) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((r) => read(r, mayDelete(seat, r, this.ctx.accountId)));
    });
  }

  /** One document with a read URL (no-store). */
  async open(
    unitId: string,
    id: string,
  ): Promise<{ document: UnitDocumentRead; read: PresignedRead }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const seat = await this.seat(tx, unitId);
      const doc = await tx.unitDocument.findFirst({
        where: { id, unitId, deletedAt: null, OR: visibleTo(seat) },
      });
      return this.withUrl(tx, doc, mayDelete(seat, doc, this.ctx.accountId));
    });
  }

  /**
   * Adds the caller's finalized `unit_document` file. An occupant keeps it
   * for themselves, the owners or the occupants; a delegate only for the
   * occupants, on the primary's behalf.
   */
  async add(unitId: string, input: NewUnitDocument): Promise<UnitDocumentRead> {
    const valid = validate(input, ['private', 'owners', 'occupants']);
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const seat = await this.seat(tx, unitId);
      const owner = seat.active?.id ?? seat.delegateFor;
      if (!owner)
        throw notAllowed('Only someone living in the unit adds documents');
      if (!seat.active && valid.visibility !== 'occupants')
        throw notAllowed('A delegate shares with the occupants only');
      if (valid.visibility === 'owners' && seat.active && !seat.active.owner)
        throw notAllowed('Only an owner shares with the owners');
      const doc = await this.create(tx, unitId, valid, owner);
      await this.audit.record(tx, {
        action: 'unit_document.added',
        targetId: doc.id,
        metadata: {
          unitId,
          kind: doc.kind,
          visibility: doc.visibility,
          side: 'resident',
          ...(seat.active ? {} : { onBehalfOf: true }),
        },
      });
      return read(doc, true);
    });
  }

  /** The owning occupancy's account, or whoever uploaded it, deletes it. */
  async remove(unitId: string, id: string): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const seat = await this.seat(tx, unitId);
      const doc = await tx.unitDocument.findFirst({
        where: { id, unitId, deletedAt: null, OR: visibleTo(seat) },
      });
      if (!doc) throw notFound();
      if (!mayDelete(seat, doc, this.ctx.accountId))
        throw notAllowed('Only its owner deletes a document');
      await this.drop(tx, doc, 'owner', await dbNow(tx));
    });
  }

  // --------------------------------------------------------------------------
  // The management's side (`unit_documents.manage`)
  // --------------------------------------------------------------------------

  /** The unit's own documents and the registrants' proofs; never a resident's upload. */
  async staffList(unitId: string): Promise<UnitDocumentRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.unit.findUnique({ where: { id: unitId } })))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const rows = await tx.unitDocument.findMany({
        where: { unitId, deletedAt: null, OR: STAFF_VISIBLE },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((r) => read(r, r.ownerOccupancyId === null));
    });
  }

  async staffOpen(
    unitId: string,
    id: string,
  ): Promise<{ document: UnitDocumentRead; read: PresignedRead }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const doc = await tx.unitDocument.findFirst({
        where: { id, unitId, deletedAt: null, OR: STAFF_VISIBLE },
      });
      return this.withUrl(tx, doc, doc?.ownerOccupancyId === null);
    });
  }

  async staffAdd(
    unitId: string,
    input: NewUnitDocument,
  ): Promise<UnitDocumentRead> {
    const valid = validate(input, ['owners', 'occupants']);
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const unit = await tx.unit.findUnique({ where: { id: unitId } });
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const doc = await this.create(tx, unitId, valid, null);
      await this.audit.record(tx, {
        action: 'unit_document.added',
        targetId: doc.id,
        metadata: {
          unitId,
          kind: doc.kind,
          visibility: doc.visibility,
          side: 'management',
        },
      });
      return read(doc, true);
    });
  }

  /** The management deletes the unit's own documents only. */
  async staffRemove(unitId: string, id: string): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const doc = await tx.unitDocument.findFirst({
        where: { id, unitId, deletedAt: null, ownerOccupancyId: null },
      });
      if (!doc) throw notFound();
      await this.drop(tx, doc, 'management', await dbNow(tx));
    });
  }

  // --------------------------------------------------------------------------
  // Registration (ADR 0062): an approved registrant's proofs join the vault
  // --------------------------------------------------------------------------

  /**
   * In the approval's transaction: each live proof of the request becomes
   * the new occupancy's private `capacity_proof` (the management sees those
   * too), and leaves the request, so the decision does not delete it.
   */
  async adoptRegistrationProofs(
    tx: TenantTxClient,
    registrationId: string,
    unitId: string,
    occupancyId: string,
  ): Promise<number> {
    const proofs = await tx.registrationDocument.findMany({
      where: { registrationId, file: { deletedAt: null, status: 'ready' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const now = await dbNow(tx);
    for (const p of proofs) {
      await tx.registrationDocument.delete({ where: { id: p.id } });
      await tx.unitDocument.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          unitId,
          fileId: p.fileId,
          kind: 'capacity_proof',
          title: p.kind,
          ownerOccupancyId: occupancyId,
          uploadedBy: null,
          visibility: 'private',
          createdAt: now,
        },
      });
    }
    return proofs.length;
  }

  // --------------------------------------------------------------------------

  private async seat(tx: TenantTxClient, unitId: string): Promise<Seat> {
    const mine = await tx.unitOccupancy.findMany({
      where: { unitId, accountId: this.ctx.accountId },
      select: { id: true, status: true, occupancyType: true },
    });
    const live = mine.find((o) => o.status === 'active');
    const ended = mine.filter((o) => o.status !== 'active').map((o) => o.id);
    let delegateFor: string | null = null;
    if (!live) {
      const unit = await tx.unit.findUnique({ where: { id: unitId } });
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const by = await this.delegateOf(tx, unitId);
      if (by) {
        const primary = await tx.unitOccupancy.findFirst({
          where: { unitId, accountId: by, status: 'active', isPrimary: true },
          select: { id: true },
        });
        delegateFor = primary?.id ?? null;
      }
      if (!delegateFor && !ended.length)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    }
    return {
      active: live
        ? { id: live.id, owner: live.occupancyType === 'owner' }
        : null,
      ended,
      delegateFor,
    };
  }

  /** The primary a `documents` delegate acts for, or null. */
  private async delegateOf(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<string | null> {
    try {
      return (
        (await this.authority.find(tx, unitId, 'documents'))?.onBehalfOf ?? null
      );
    } catch {
      // An expired delegation reads as none here.
      return null;
    }
  }

  private async create(
    tx: TenantTxClient,
    unitId: string,
    valid: ValidDocument,
    ownerOccupancyId: string | null,
  ): Promise<UnitDocument> {
    const live = await tx.unitDocument.count({
      where: { unitId, deletedAt: null },
    });
    if (live >= UNIT_DOCUMENT_LIMIT)
      throw appError.conflict(
        ErrorCode.UNIT_DOCUMENT_LIMIT,
        'The unit holds as many documents as it may',
        { params: { limit: UNIT_DOCUMENT_LIMIT } },
      );
    const file = await this.files.claim(tx, valid.fileId, 'unit_document');
    if (!file)
      throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
    await this.files.attach(tx, file);
    return tx.unitDocument.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        unitId,
        fileId: file.id,
        kind: valid.kind,
        title: valid.title,
        ownerOccupancyId,
        uploadedBy: this.ctx.accountId,
        visibility: valid.visibility,
        expiresOn: valid.expiresOn,
        createdAt: await dbNow(tx),
      },
    });
  }

  private async drop(
    tx: TenantTxClient,
    doc: UnitDocument,
    reasonCode: 'owner' | 'management' | 'retention' | 'erasure',
    now: Date,
  ): Promise<void> {
    await tx.unitDocument.update({
      where: { id: doc.id },
      data: { deletedAt: now },
    });
    // The files sweep deletes the object, then the file's row (and this
    // row with it).
    await this.files.markDeleted(
      tx,
      { id: doc.fileId, purpose: 'unit_document' },
      reasonCode === 'owner' || reasonCode === 'management'
        ? 'owner'
        : reasonCode,
    );
    await this.audit.record(tx, {
      action: 'unit_document.deleted',
      targetId: doc.id,
      metadata: { unitId: doc.unitId, kind: doc.kind, reasonCode },
    });
  }

  private async withUrl(
    tx: TenantTxClient,
    doc: UnitDocument | null,
    mine: boolean,
  ) {
    const url = doc ? await this.files.readUrl(tx, doc.fileId) : null;
    if (!doc || !url) throw notFound();
    return { document: read(doc, mine), read: url };
  }

  /**
   * The warranty sweep: a warranty within WARRANTY_NOTICE_DAYS of its end
   * (the compound's local day) tells whoever its visibility reaches, once.
   */
  async warranties(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<UnitDocument[]>`
        SELECT d.id FROM unit_documents d, tenant_settings s
         WHERE s.tenant_id = d.tenant_id
           AND d.expires_on IS NOT NULL AND d.expiry_notified_at IS NULL
           AND d.deleted_at IS NULL
           AND d.expires_on - ${WARRANTY_NOTICE_DAYS}::int
               <= (${now}::timestamptz AT TIME ZONE s.timezone)::date
         ORDER BY d.expires_on LIMIT 500
         FOR UPDATE OF d SKIP LOCKED`;
      for (const { id } of due) {
        const doc = await tx.unitDocument.update({
          where: { id },
          data: { expiryNotifiedAt: now },
          include: {
            ownerOccupancy: { select: { status: true, accountId: true } },
          },
        });
        const reach =
          doc.ownerOccupancyId && doc.ownerOccupancy?.status !== 'active'
            ? []
            : doc.visibility === 'private'
              ? [doc.ownerOccupancy!.accountId]
              : (
                  await tx.unitOccupancy.findMany({
                    where: {
                      unitId: doc.unitId,
                      status: 'active',
                      ...(doc.visibility === 'owners'
                        ? { occupancyType: 'owner' }
                        : {}),
                    },
                    select: { accountId: true },
                  })
                ).map((o) => o.accountId);
        await this.notifier.notify(tx, reach, {
          kind: 'unit_document.warranty_expiring',
          params: { expiresOn: doc.expiresOn!.toISOString().slice(0, 10) },
          targetId: doc.id,
        });
      }
      return due.length;
    });
  }

  /** The retention sweep: an ended occupancy's documents, 90 days after its handover or end. */
  async retain(now: Date): Promise<number> {
    const before = new Date(
      now.getTime() - UNIT_DOCUMENT_RETENTION_DAYS * 86_400_000,
    );
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.unitDocument.findMany({
        where: {
          deletedAt: null,
          ownerOccupancy: {
            status: 'ended',
            OR: [
              { handedOverAt: { lt: before } },
              { handedOverAt: null, endedAt: { lt: before } },
            ],
          },
        },
        take: 500,
      });
      for (const doc of due) await this.drop(tx, doc, 'retention', now);
      return due.length;
    });
  }
}

/** What the management sees: the unit's own, and the registrants' proofs. */
const STAFF_VISIBLE: Prisma.UnitDocumentWhereInput[] = [
  { ownerOccupancyId: null },
  { kind: 'capacity_proof' },
];

/**
 * The caller's view: shared documents of the unit or of a live occupancy,
 * by level, and their own occupancies' documents whatever the level.
 */
function visibleTo(seat: Seat): Prisma.UnitDocumentWhereInput[] {
  const shared = (visibility: UnitDocumentVisibility) => ({
    visibility,
    OR: [
      { ownerOccupancyId: null },
      { ownerOccupancy: { status: 'active' as const } },
    ],
  });
  const out: Prisma.UnitDocumentWhereInput[] = [];
  if (seat.active || seat.delegateFor) out.push(shared('occupants'));
  if (seat.active?.owner) out.push(shared('owners'));
  const own = [...seat.ended, ...(seat.active ? [seat.active.id] : [])];
  if (own.length) out.push({ ownerOccupancyId: { in: own } });
  return out.length ? out : [{ id: { in: [] } }];
}

function mayDelete(
  seat: Seat,
  doc: UnitDocument | null,
  accountId: string,
): boolean {
  if (!doc) return false;
  if (doc.ownerOccupancyId === null) return false;
  return (
    doc.ownerOccupancyId === seat.active?.id ||
    seat.ended.includes(doc.ownerOccupancyId) ||
    doc.uploadedBy === accountId
  );
}

function read(r: UnitDocument, mine: boolean): UnitDocumentRead {
  return {
    id: r.id,
    unitId: r.unitId,
    kind: r.kind as UnitDocumentKind,
    title: r.title,
    visibility: r.visibility as UnitDocumentVisibility,
    holder: r.ownerOccupancyId ? 'occupancy' : 'unit',
    mine,
    expiresOn: r.expiresOn,
    createdAt: r.createdAt,
  };
}

interface ValidDocument {
  fileId: string;
  kind: UnitDocumentKind;
  title: string;
  visibility: UnitDocumentVisibility;
  expiresOn: Date | null;
}

function validate(
  input: NewUnitDocument,
  visibilities: readonly UnitDocumentVisibility[],
): ValidDocument {
  const fields: FieldError[] = [];
  if (!(ADDABLE_KINDS as readonly string[]).includes(input.kind))
    fields.push({
      field: 'kind',
      code: FieldErrorCode.INVALID_VALUE,
      params: { allowed: [...ADDABLE_KINDS] },
    });
  if (!(visibilities as readonly string[]).includes(input.visibility))
    fields.push({
      field: 'visibility',
      code: FieldErrorCode.INVALID_VALUE,
      params: { allowed: [...visibilities] },
    });
  const title = (input.title ?? '').trim();
  if (title.length < 1 || title.length > 120)
    fields.push({
      field: 'title',
      code: FieldErrorCode.INVALID_LENGTH,
      params: { min: 1, max: 120 },
    });
  let expiresOn: Date | null = null;
  if (input.kind === 'warranty') {
    // The DTO took a real day (@IsLocalDate); a warranty needs one.
    if (!input.expiresOn)
      fields.push({ field: 'expiresOn', code: FieldErrorCode.FIELD_REQUIRED });
    else expiresOn = new Date(`${input.expiresOn}T00:00:00Z`);
  } else if (input.expiresOn !== undefined)
    fields.push({ field: 'expiresOn', code: FieldErrorCode.FIELD_NOT_ALLOWED });
  if (fields.length)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid document', {
      fields,
    });
  return {
    fileId: input.fileId,
    kind: input.kind as UnitDocumentKind,
    title,
    visibility: input.visibility as UnitDocumentVisibility,
    expiresOn,
  };
}
