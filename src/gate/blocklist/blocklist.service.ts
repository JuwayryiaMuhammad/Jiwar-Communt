import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BlocklistEntry, BlocklistMatch, Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { IdentifierHasher } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { normalizeIdNumber } from '../../core/common/id-number';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  normalizePlate,
  PLATE_MAX,
  plateKey,
} from '../../core/common/vehicle-plate';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { BlocklistCore } from './blocklist-core';
import { StaffBlocklistEntryView } from './views/blocklist.views';

export const BLOCKLIST_RESOURCE = 'blocklist_entry';
export const BLOCKLIST_SWEEP = 'gate.blocklist';
/** A person's data is kept this long after their entry was lifted. */
export const BLOCKLIST_PURGE_DAYS = 30;
/** An expiry is in the future, at most this far. */
export const MAX_EXPIRY_DAYS = 1095;
export const NAME = { min: 2, max: 120 } as const;
export const NOTE = { min: 1, max: 1000 } as const;
const DAY_MS = 86_400_000;
const SWEEP_BATCH = 500;
const PAGE = keysetCursor('createdAt', 'desc');

export type BlocklistKind = 'ban' | 'watch';
export type BlocklistSubject = 'plate' | 'person';
export type BlocklistStatus = 'active' | 'expired' | 'lifted';

type Person = { id: string; fullName: string | null; status: string };

/** An entry with what its views show, read in one transaction. */
export interface BlocklistRecord {
  entry: BlocklistEntry;
  status: BlocklistStatus;
  photo: PresignedRead | null;
  createdBy: Person;
  liftedBy: Person | null;
}

export interface NewEntry {
  kind: BlocklistKind;
  subject: BlocklistSubject;
  plate?: string;
  fullName?: string;
  idNumber?: string;
  photoFileId?: string;
  reasonCode: string;
  note?: string;
  expiresAt?: Date;
}

export interface EntryChanges {
  kind?: BlocklistKind;
  reasonCode?: string;
  note?: string | null;
  expiresAt?: Date | null;
  photoFileId?: string | null;
}

/** Where an entry was met, as its keepers read it. */
export interface MatchRecord {
  match: BlocklistMatch;
  gate: { id: string; name: string } | null;
  actor: Person;
}

const MATCH_PAGE = keysetCursor('createdAt', 'desc');

export const blocklistNotFound = () =>
  appError.notFound(
    ErrorCode.BLOCKLIST_ENTRY_NOT_FOUND,
    'Blocklist entry not found',
  );

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid entry', {
    fields,
  });

/**
 * The blocklist and the watchlist (ADR 0053), kept by `blocklist.manage`.
 *
 * An entry is a plate, or a person: a name, the full ID number (stored
 * only as its peppered HMAC, bound to the compound) and an optional face.
 * `ban` refuses them at the gate, `watch` lets them in and tells the
 * management. One live entry per plate and per person. Its subject never
 * changes; its kind, reason, note, expiry and photo do while it is live.
 * It is lifted once, by the management, or by the sweep once its expiry
 * passed; 30 days after a person's entry was lifted, the person's data
 * goes. The guards on shift read the active list: kind, plate or name, and
 * the face. Every write runs under the compound's blocklist lock.
 */
@Injectable()
export class BlocklistService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly hasher: IdentifierHasher,
    private readonly files: FilesService,
    private readonly sweep: SweepRunner,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly core: BlocklistCore,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BLOCKLIST_RESOURCE, async (id) =>
      StaffBlocklistEntryView.from(await this.get(id)),
    );
    this.sweep.register(BLOCKLIST_SWEEP, (now) => this.expireAndPurge(now));
  }

  // --------------------------------------------------------------------------
  // The management (`blocklist.manage`)
  // --------------------------------------------------------------------------

  create(input: NewEntry): Promise<BlocklistRecord> {
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.blocklistReason,
    );
    const subject = this.subjectOf(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      await this.core.lockWrite(tx);
      const now = await dbNow(tx);
      this.checkExpiry(input.expiresAt, now);
      const idHash =
        subject.idNumber !== null
          ? this.hasher.hashBlocklistId(this.ctx.txTenantId, subject.idNumber)
          : null;
      const same: Prisma.BlocklistEntryWhereInput =
        subject.plate !== null
          ? { subject: 'plate', plateKey: plateKey(subject.plate) }
          : { subject: 'person', idHash };
      // A live entry past its expiry is the sweep's to lift: lift it here,
      // so the new one may take its place.
      for (const old of await tx.blocklistEntry.findMany({
        where: { ...same, liftedAt: null, expiresAt: { lte: now } },
        select: { id: true },
      }))
        await this.expire(tx, old.id, now);
      if (await tx.blocklistEntry.count({ where: { ...same, liftedAt: null } }))
        throw appError.conflict(
          ErrorCode.DUPLICATE_RESOURCE,
          'This plate or person is on the list already',
          {
            fields: [
              {
                field: subject.plate !== null ? 'plate' : 'idNumber',
                code: FieldErrorCode.DUPLICATE_VALUE,
              },
            ],
          },
        );
      const id = newId();
      await this.idempotency.claim(tx, { type: BLOCKLIST_RESOURCE, id });
      const photo = input.photoFileId
        ? await this.claimPhoto(tx, input.photoFileId)
        : null;
      const entry = await tx.blocklistEntry.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          kind: input.kind,
          subject: input.subject,
          plate: subject.plate,
          fullName: subject.fullName,
          idHash,
          photoFileId: photo,
          reasonCode,
          note: input.note ?? null,
          expiresAt: input.expiresAt ?? null,
          createdById: me,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'blocklist_entry.created',
        targetId: id,
        metadata: {
          kind: input.kind,
          subject: input.subject,
          reasonCode,
          expiresAt: input.expiresAt?.toISOString() ?? null,
          photo: photo !== null,
          note: input.note !== undefined,
        },
      });
      return this.record(tx, entry, now);
    });
  }

  list(q: {
    status?: BlocklistStatus;
    kind?: BlocklistKind;
    cursor?: string;
    limit?: number;
  }): Promise<Page<BlocklistRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const rows = await tx.blocklistEntry.findMany({
        where: {
          AND: [
            ...(q.kind ? [{ kind: q.kind }] : []),
            ...(q.status === 'active'
              ? [this.core.active(now)]
              : q.status === 'expired'
                ? [{ liftedAt: null, expiresAt: { lte: now } }]
                : q.status === 'lifted'
                  ? [{ liftedAt: { not: null } }]
                  : []),
            ...(PAGE.after(q.cursor) as Prisma.BlocklistEntryWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.records(tx, items, now), nextCursor };
    });
  }

  get(id: string): Promise<BlocklistRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const entry = await tx.blocklistEntry.findUnique({ where: { id } });
      if (!entry) throw blocklistNotFound();
      return this.record(tx, entry, await dbNow(tx));
    });
  }

  /** What a live entry says: kind, reason, note, expiry, photo. */
  update(id: string, input: EntryChanges): Promise<BlocklistRecord> {
    const reasonCode =
      input.reasonCode === undefined
        ? undefined
        : requireReasonCodeOnly(input.reasonCode, REASON_CODES.blocklistReason);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.core.lockWrite(tx);
      const entry = await tx.blocklistEntry.findUnique({ where: { id } });
      if (!entry) throw blocklistNotFound();
      if (entry.liftedAt) throw lifted();
      const now = await dbNow(tx);
      if (input.expiresAt) this.checkExpiry(input.expiresAt, now);
      const data: Prisma.BlocklistEntryUpdateInput = {};
      const changed: string[] = [];
      if (input.kind !== undefined && input.kind !== entry.kind) {
        data.kind = input.kind;
        changed.push('kind');
      }
      if (reasonCode !== undefined && reasonCode !== entry.reasonCode) {
        data.reasonCode = reasonCode;
        changed.push('reasonCode');
      }
      if (input.note !== undefined && input.note !== entry.note) {
        data.note = input.note;
        changed.push('note');
      }
      if (
        input.expiresAt !== undefined &&
        (input.expiresAt?.getTime() ?? null) !==
          (entry.expiresAt?.getTime() ?? null)
      ) {
        data.expiresAt = input.expiresAt;
        changed.push('expiresAt');
      }
      if (
        input.photoFileId !== undefined &&
        input.photoFileId !== entry.photoFileId
      ) {
        if (input.photoFileId && entry.subject !== 'person')
          throw invalid([
            { field: 'photoFileId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
          ]);
        data.photoFileId = input.photoFileId
          ? await this.claimPhoto(tx, input.photoFileId)
          : null;
        if (entry.photoFileId)
          await this.files.markDeleted(
            tx,
            { id: entry.photoFileId, purpose: 'blocklist_photo' },
            'replaced',
          );
        changed.push('photo');
      }
      if (!changed.length) return this.record(tx, entry, now);
      const updated = await tx.blocklistEntry.update({ where: { id }, data });
      await this.audit.record(tx, {
        action: 'blocklist_entry.updated',
        targetId: id,
        metadata: {
          changed,
          kind: updated.kind,
          reasonCode: updated.reasonCode,
          expiresAt: updated.expiresAt?.toISOString() ?? null,
        },
      });
      return this.record(tx, updated, now);
    });
  }

  /** The management lifts a live entry, with a reason code. */
  lift(id: string, reasonCodeIn: string): Promise<BlocklistRecord> {
    const reasonCode = requireReasonCodeOnly(
      reasonCodeIn,
      REASON_CODES.blocklistLift,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.core.lockWrite(tx);
      const entry = await tx.blocklistEntry.findUnique({ where: { id } });
      if (!entry) throw blocklistNotFound();
      if (entry.liftedAt) throw lifted();
      const now = await dbNow(tx);
      const updated = await tx.blocklistEntry.update({
        where: { id },
        data: {
          liftedAt: now,
          liftedById: this.ctx.accountId,
          liftReason: reasonCode,
        },
      });
      await this.audit.record(tx, {
        action: 'blocklist_entry.lifted',
        targetId: id,
        metadata: { reasonCode },
      });
      return this.record(tx, updated, now);
    });
  }

  /** Where the gate met an entry (ADR 0053), newest first. */
  matches(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MatchRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.blocklistEntry.count({ where: { id } })))
        throw blocklistNotFound();
      const rows = await tx.blocklistMatch.findMany({
        where: {
          AND: [
            { entryId: id },
            ...(MATCH_PAGE.after(
              q.cursor,
            ) as Prisma.BlocklistMatchWhereInput[]),
          ],
        },
        orderBy: MATCH_PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = MATCH_PAGE.toPage(rows, limit);
      const gates = new Map(
        (
          await tx.gate.findMany({
            where: {
              id: { in: items.flatMap((m) => (m.gateId ? [m.gateId] : [])) },
            },
            select: { id: true, name: true },
          })
        ).map((g) => [g.id, g]),
      );
      const people = new Map(
        (
          await tx.account.findMany({
            where: {
              id: { in: [...new Set(items.map((m) => m.actorAccountId))] },
            },
            select: { id: true, fullName: true, status: true },
          })
        ).map((a) => [a.id, a]),
      );
      return {
        items: items.map((m) => ({
          match: m,
          gate: m.gateId ? (gates.get(m.gateId) ?? null) : null,
          actor: people.get(m.actorAccountId)!,
        })),
        nextCursor,
      };
    });
  }

  // --------------------------------------------------------------------------
  // The guards on shift
  // --------------------------------------------------------------------------

  /** The active list, for a guard on shift (a gate or a zone). */
  active(): Promise<BlocklistRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOnDuty(tx);
      const now = await dbNow(tx);
      const rows = await tx.blocklistEntry.findMany({
        where: this.core.active(now),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return this.records(tx, rows, now);
    });
  }

  // --------------------------------------------------------------------------
  // The sweep: expiry, and the purge of a person's data
  // --------------------------------------------------------------------------

  /**
   * Once an hour, per compound, under its blocklist lock: the live entries
   * past their expiry are lifted (`expired`, by the system), and a person's
   * name, ID hash, photo and note go 30 days after their entry was lifted.
   */
  expireAndPurge(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      await this.core.lockWrite(tx);
      const at = await dbNow(tx);
      const due = await tx.blocklistEntry.findMany({
        where: { liftedAt: null, expiresAt: { lte: now } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
      });
      for (const { id } of due) await this.expire(tx, id, at);
      const old = await tx.blocklistEntry.findMany({
        where: {
          subject: 'person',
          purgedAt: null,
          liftedAt: {
            lte: new Date(now.getTime() - BLOCKLIST_PURGE_DAYS * DAY_MS),
          },
        },
        select: { id: true, photoFileId: true },
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
      });
      for (const e of old) {
        await tx.blocklistEntry.update({
          where: { id: e.id },
          data: {
            fullName: null,
            idHash: null,
            photoFileId: null,
            note: null,
            purgedAt: at,
          },
        });
        if (e.photoFileId)
          await this.files.markDeleted(
            tx,
            { id: e.photoFileId, purpose: 'blocklist_photo' },
            'retention',
          );
        await this.audit.record(tx, {
          action: 'blocklist_entry.purged',
          targetId: e.id,
          metadata: { photo: e.photoFileId !== null },
        });
      }
      return due.length + old.length;
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async expire(
    tx: TenantTxClient,
    id: string,
    at: Date,
  ): Promise<void> {
    await tx.blocklistEntry.update({
      where: { id },
      data: { liftedAt: at, liftedById: null, liftReason: 'expired' },
    });
    await this.audit.record(tx, {
      action: 'blocklist_entry.expired',
      targetId: id,
    });
  }

  /** What the entry is about, tidied, or 400 naming what does not fit. */
  private subjectOf(input: NewEntry): {
    plate: string | null;
    fullName: string | null;
    idNumber: string | null;
  } {
    const fields: FieldError[] = [];
    const notAllowed = (field: string) =>
      fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
    const required = (field: string) =>
      fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
    if (input.subject === 'plate') {
      for (const f of ['fullName', 'idNumber', 'photoFileId'] as const)
        if (input[f] !== undefined) notAllowed(f);
      if (input.plate === undefined) required('plate');
      const plate =
        input.plate === undefined ? null : normalizePlate(input.plate);
      if (input.plate !== undefined && !plate)
        fields.push({
          field: 'plate',
          code: FieldErrorCode.INVALID_FORMAT,
          params: { maxLength: PLATE_MAX },
        });
      if (fields.length) throw invalid(fields);
      return { plate, fullName: null, idNumber: null };
    }
    if (input.plate !== undefined) notAllowed('plate');
    const fullName = input.fullName?.trim().replace(/\s+/g, ' ') ?? '';
    if (input.fullName === undefined) required('fullName');
    else if (fullName.length < NAME.min || fullName.length > NAME.max)
      fields.push({
        field: 'fullName',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...NAME },
      });
    const idNumber =
      input.idNumber === undefined ? null : normalizeIdNumber(input.idNumber);
    if (input.idNumber === undefined) required('idNumber');
    else if (!idNumber)
      fields.push({ field: 'idNumber', code: FieldErrorCode.INVALID_FORMAT });
    if (fields.length) throw invalid(fields);
    return { plate: null, fullName, idNumber };
  }

  private checkExpiry(expiresAt: Date | undefined, now: Date): void {
    if (
      expiresAt &&
      (expiresAt.getTime() <= now.getTime() ||
        expiresAt.getTime() > now.getTime() + MAX_EXPIRY_DAYS * DAY_MS)
    )
      throw invalid([
        {
          field: 'expiresAt',
          code: FieldErrorCode.INVALID_VALUE,
          params: { maxDays: MAX_EXPIRY_DAYS },
        },
      ]);
  }

  private async claimPhoto(
    tx: TenantTxClient,
    fileId: string,
  ): Promise<string> {
    const file = await this.files.claim(tx, fileId, 'blocklist_photo');
    if (!file)
      throw invalid([
        { field: 'photoFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
      ]);
    await this.files.attach(tx, file);
    return file.id;
  }

  private async record(
    tx: TenantTxClient,
    entry: BlocklistEntry,
    now: Date,
  ): Promise<BlocklistRecord> {
    return (await this.records(tx, [entry], now))[0];
  }

  /** Entries with what their views show (the ID lookup's too). */
  async records(
    tx: TenantTxClient,
    list: BlocklistEntry[],
    now: Date,
  ): Promise<BlocklistRecord[]> {
    if (!list.length) return [];
    const people = new Map(
      (
        await tx.account.findMany({
          where: {
            id: {
              in: [
                ...new Set(
                  list.flatMap((e) =>
                    e.liftedById
                      ? [e.createdById, e.liftedById]
                      : [e.createdById],
                  ),
                ),
              ],
            },
          },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    const out: BlocklistRecord[] = [];
    for (const e of list)
      out.push({
        entry: e,
        status: e.liftedAt
          ? 'lifted'
          : e.expiresAt && e.expiresAt.getTime() <= now.getTime()
            ? 'expired'
            : 'active',
        photo: await this.files.readUrl(tx, e.photoFileId),
        createdBy: people.get(e.createdById)!,
        liftedBy: e.liftedById ? people.get(e.liftedById)! : null,
      });
    return out;
  }
}

const lifted = () =>
  appError.conflict(
    ErrorCode.BLOCKLIST_ENTRY_LIFTED,
    'The entry was lifted already',
  );
