import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { UnitEntry } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import {
  ENTRY_NOTE,
  ENTRY_PHOTOS,
  ENTRY_WITNESSES,
  entryReference,
  type EntryPhoto,
  type EntryRead,
} from './unit-entry-rules';
import { StaffUnitEntryView } from './views/unit-entry.views';

export const UNIT_ENTRY_RESOURCE = 'unit_entry';
/** A clock a little ahead of the database's is not "in the future". */
const SKEW_MS = 5 * 60_000;
/** How far back an entry may be recorded: within a week of it. */
const MAX_BACK_MS = 7 * 86_400_000;
const PAGE = keysetCursor('recordedAt');

const entryNotFound = () =>
  appError.notFound(ErrorCode.UNIT_ENTRY_NOT_FOUND, 'Unit entry not found');

/**
 * Emergency entries into a unit (ADR 0083), the management's
 * (`guard_tasks.manage`): staff went in without the owner, for a danger
 * (a leak, fire, smoke, gas, an electrical or structural danger, a threat).
 * It is never silent:
 *
 * - **Recorded** by the person who led it: the unit, the reason's code,
 *   when, one to three witnesses (staff accounts, so two staff at least),
 *   and photos before, through the files service (`unit_entry_photo`). In
 *   the same transaction every active occupant of the unit and its active
 *   proxies with `inspections` are told (`unit_entry.recorded`, critical:
 *   delivered whatever the preferences say).
 * - **Reported** once afterwards: what was found (a code), the staff's
 *   words and at least one photo after. Until then it waits in the staff
 *   inbox (`unit_entry_report`, due within a day). The same people are told.
 *
 * The unit's people read its entries — when, why, what was found, the
 * report and the photos (presigned, no-store) — never the staff's names.
 * Locks: the recorder's account (FOR SHARE), then the entry's row for its
 * report, so a report is written once.
 */
@Injectable()
export class UnitEntriesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityGatePort,
    private readonly files: FilesService,
    private readonly notifier: Notifier,
    private readonly safety: SafetyCore,
    private readonly inbox: StaffInbox,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(UNIT_ENTRY_RESOURCE, async (id) =>
      StaffUnitEntryView.fromStaff(await this.get(id)),
    );
    this.inbox.register({
      type: 'unit_entry_report',
      permission: 'guard_tasks.manage',
      dueHours: 24,
      page: async (tx, q) => {
        const rows = await tx.unitEntry.findMany({
          where: {
            AND: [
              { status: 'open' },
              ...waitingSince('recordedAt', q.requestedBefore),
              ...afterCursor('recordedAt', q.after),
            ],
          },
          orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            unitId: true,
            reasonCode: true,
            recordedAt: true,
          },
        });
        return rows.map((r) => ({
          type: 'unit_entry_report' as const,
          id: r.id,
          number: entryReference(r.number),
          kind: r.reasonCode,
          status: r.status,
          unitId: r.unitId,
          requestedAt: r.recordedAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.unitEntry.count({
          where: {
            AND: [{ status: 'open' }, ...waitingSince('recordedAt', before)],
          },
        }),
    });
  }

  // --------------------------------------------------------------------------
  // The management
  // --------------------------------------------------------------------------

  /** `Idempotency-Key`. */
  record(input: {
    unitId: string;
    reasonCode?: string;
    enteredAt: Date;
    witnessIds: string[];
    photoFileIds?: string[];
  }): Promise<EntryRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.unitEntryReason,
    );
    const witnesses = [...new Set(input.witnessIds)];
    const photoIds = [...new Set(input.photoFileIds ?? [])];
    const fields: FieldError[] = [];
    if (
      witnesses.length < ENTRY_WITNESSES.min ||
      witnesses.length > ENTRY_WITNESSES.max ||
      witnesses.includes(this.ctx.accountId)
    )
      fields.push({
        field: 'witnessIds',
        code: FieldErrorCode.INVALID_VALUE,
        params: { ...ENTRY_WITNESSES },
      });
    if (photoIds.length > ENTRY_PHOTOS.before)
      fields.push({
        field: 'photoFileIds',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 0, max: ENTRY_PHOTOS.before },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: UNIT_ENTRY_RESOURCE, id });
      await this.safety.lockSelf(tx);
      const codes = await this.community.unitCodes(tx, [input.unitId]);
      const unitCode = codes.get(input.unitId);
      if (!unitCode)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const now = await dbNow(tx);
      if (
        input.enteredAt.getTime() > now.getTime() + SKEW_MS ||
        input.enteredAt.getTime() < now.getTime() - MAX_BACK_MS
      )
        throw invalid([
          {
            field: 'enteredAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxDaysBack: 7 },
          },
        ]);
      const staff = await tx.account.findMany({
        where: {
          id: { in: witnesses },
          type: { in: ['staff', 'manager'] },
          status: 'active',
        },
        select: { id: true },
      });
      if (staff.length !== witnesses.length)
        throw invalid([
          { field: 'witnessIds', code: FieldErrorCode.INVALID_VALUE },
        ]);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        hashtext(${`unit-entry-number:${this.ctx.txTenantId}`}), 0)`;
      const last = await tx.unitEntry.findFirst({
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const entry = await tx.unitEntry.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number: (last?.number ?? 0) + 1,
          unitId: input.unitId,
          reasonCode: reason,
          enteredAt: input.enteredAt,
          recordedBy: this.ctx.accountId,
          recordedAt: now,
        },
      });
      await tx.unitEntryWitness.createMany({
        data: witnesses.map((accountId) => ({
          tenantId: this.ctx.txTenantId,
          entryId: id,
          accountId,
        })),
      });
      await this.attachPhotos(tx, id, photoIds, 'before', now);
      const audience = await this.community.entryAudience(tx, input.unitId);
      const told = await this.notifier.notify(tx, audience, {
        kind: 'unit_entry.recorded',
        params: { unitCode, entryReason: reason },
        targetId: id,
      });
      await this.audit.record(tx, {
        action: 'unit_entry.recorded',
        targetId: id,
        metadata: {
          unitId: input.unitId,
          reasonCode: reason,
          witnesses: witnesses.length,
          photos: photoIds.length,
          told,
        },
      });
      return this.readOne(tx, entry, true);
    });
  }

  /** Once, with what was found, the staff's words and photos after. */
  report(
    id: string,
    input: { outcome?: string; note: string; photoFileIds: string[] },
  ): Promise<EntryRead> {
    const outcome = requireReasonCodeOnly(
      input.outcome,
      REASON_CODES.unitEntryOutcome,
    );
    const note = input.note.trim();
    const photoIds = [...new Set(input.photoFileIds)];
    const fields: FieldError[] = [];
    if (note.length < ENTRY_NOTE.min || note.length > ENTRY_NOTE.max)
      fields.push({
        field: 'note',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...ENTRY_NOTE },
      });
    if (photoIds.length < 1 || photoIds.length > ENTRY_PHOTOS.after)
      fields.push({
        field: 'photoFileIds',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: ENTRY_PHOTOS.after },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM unit_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const entry = await tx.unitEntry.findUnique({ where: { id } });
      if (!entry) throw entryNotFound();
      if (entry.status !== 'open')
        throw appError.conflict(
          ErrorCode.UNIT_ENTRY_REPORTED,
          'The entry’s report is written already',
        );
      const now = await dbNow(tx);
      await this.attachPhotos(tx, id, photoIds, 'after', now);
      const reported = await tx.unitEntry.update({
        where: { id },
        data: {
          status: 'reported',
          outcome,
          reportNote: note,
          reportedBy: this.ctx.accountId,
          reportedAt: now,
        },
      });
      const unitCode = await this.community.unitCode(tx, entry.unitId);
      const audience = await this.community.entryAudience(tx, entry.unitId);
      const told = await this.notifier.notify(tx, audience, {
        kind: 'unit_entry.reported',
        params: { unitCode, outcome },
        targetId: id,
      });
      await this.audit.record(tx, {
        action: 'unit_entry.reported',
        targetId: id,
        metadata: {
          unitId: entry.unitId,
          outcome,
          photos: photoIds.length,
          told,
        },
      });
      return this.readOne(tx, reported, true);
    });
  }

  list(q: {
    unitId?: string;
    status?: 'open' | 'reported';
    cursor?: string;
    limit?: number;
  }): Promise<Page<EntryRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.unitEntry.findMany({
        where: {
          AND: [
            q.unitId ? { unitId: q.unitId } : {},
            q.status ? { status: q.status } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: EntryRead[] = [];
      for (const e of page.items) items.push(await this.readOne(tx, e, true));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<EntryRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const entry = await tx.unitEntry.findUnique({ where: { id } });
      if (!entry) throw entryNotFound();
      return this.readOne(tx, entry, true);
    });
  }

  // --------------------------------------------------------------------------
  // The unit's side
  // --------------------------------------------------------------------------

  /**
   * The unit's entries, newest first, for its active occupants and its
   * active proxies with `inspections`; another unit is not found.
   */
  forUnit(unitId: string): Promise<EntryRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const audience = await this.community.entryAudience(tx, unitId);
      if (!audience.includes(this.ctx.accountId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const rows = await tx.unitEntry.findMany({
        where: { unitId },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
      const out: EntryRead[] = [];
      for (const e of rows) out.push(await this.readOne(tx, e, false));
      return out;
    });
  }

  // --------------------------------------------------------------------------

  private async attachPhotos(
    tx: TenantTxClient,
    entryId: string,
    fileIds: string[],
    stage: 'before' | 'after',
    now: Date,
  ): Promise<void> {
    for (const [i, fileId] of fileIds.entries()) {
      const file = await this.files.claim(tx, fileId, 'unit_entry_photo');
      if (!file)
        throw invalid([
          {
            field: `photoFileIds.${i}`,
            code: FieldErrorCode.FILE_NOT_AVAILABLE,
          },
        ]);
      await this.files.attach(tx, file);
      await tx.unitEntryPhoto.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          entryId,
          fileId: file.id,
          stage,
          uploadedBy: this.ctx.accountId,
          createdAt: now,
        },
      });
    }
  }

  private async readOne(
    tx: TenantTxClient,
    e: UnitEntry,
    staff: boolean,
  ): Promise<EntryRead> {
    const witnesses = await tx.unitEntryWitness.findMany({
      where: { entryId: e.id },
      select: { accountId: true },
      orderBy: { accountId: 'asc' },
    });
    const photos = await tx.unitEntryPhoto.findMany({
      where: { entryId: e.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const urls: EntryPhoto[] = [];
    for (const p of photos) {
      const url = await this.files.readUrl(tx, p.fileId);
      if (url)
        urls.push({
          stage: p.stage as EntryPhoto['stage'],
          url: url.url,
          expiresAt: url.expiresAt,
        });
    }
    let recordedByName: string | null = null;
    let witnessNames: (string | null)[] = [];
    if (staff) {
      const people = await tx.account.findMany({
        where: {
          id: { in: [e.recordedBy, ...witnesses.map((w) => w.accountId)] },
        },
        select: { id: true, fullName: true, status: true },
      });
      const name = (id: string) => {
        const p = people.find((x) => x.id === id);
        return !p || p.status === 'erased' ? null : (p.fullName ?? null);
      };
      recordedByName = name(e.recordedBy);
      witnessNames = witnesses.map((w) => name(w.accountId));
    }
    return {
      entry: e,
      unitCode: await this.community.unitCode(tx, e.unitId),
      witnessCount: witnesses.length,
      photos: urls,
      recordedByName,
      witnessNames,
    };
  }
}
