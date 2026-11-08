import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  ComplianceEvidence,
  ComplianceItem,
  ComplianceOccurrence,
  Prisma,
} from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { toCsv, type CsvColumn } from '../../core/common/csv';
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
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  addDays,
  daysBetween,
  dateColumn,
  ofDateColumn,
  ofDateColumnOrNull,
  type LocalDate,
} from '../schedules/local-dates';
import { TicketAccess } from '../tickets/ticket-access';
import { CERTIFICATE_NOTICE_DAYS } from '../certificates/certificate-rules';
import { VENDOR_DOCUMENT_NOTICE_DAYS } from '../vendors/vendor-rules';
import { VendorsService } from '../vendors/vendors.service';
import {
  CALENDAR_MAX_DAYS,
  COMPLIANCE_KINDS,
  DEFAULT_LEAD_DAYS,
  EVIDENCE_MAX,
  earliestDone,
  latestDue,
  leadTimes,
  nextDueOn,
  normalLeads,
  stateOf,
  type ComplianceKind,
  type ComplianceState,
} from './compliance-rules';

export const COMPLIANCE_ITEM_RESOURCE = 'compliance_item';

type Person = { id: string; fullName: string | null; status: string };

export interface ComplianceItemInput {
  kind: ComplianceKind;
  title: string;
  authority?: string;
  reference?: string;
  assetId?: string;
  commonAreaId?: string;
  vendorId?: string;
  ownerId?: string;
  recurrenceMonths?: number;
  leadDays?: number[];
  notes?: string;
  firstDueOn: LocalDate;
}

/** Every field optional; null clears an optional one; `[]` lead times: the compound's. */
export interface ComplianceItemUpdate {
  title?: string;
  authority?: string | null;
  reference?: string | null;
  assetId?: string | null;
  commonAreaId?: string | null;
  vendorId?: string | null;
  ownerId?: string | null;
  recurrenceMonths?: number | null;
  leadDays?: number[];
  notes?: string | null;
  /** Moves the open due day; its notices start again. */
  nextDueOn?: LocalDate;
}

export interface CompletionInput {
  doneOn: LocalDate;
  certificateNumber?: string;
  expiresOn?: LocalDate;
  note?: string;
  nextDueOn?: LocalDate;
  fileIds?: string[];
}

export interface ComplianceItemRead {
  item: ComplianceItem;
  /** The open due day, if any. */
  current: ComplianceOccurrence | null;
  /** The last one done, if any. */
  lastDone: ComplianceOccurrence | null;
  state: ComplianceState;
  /** The lead times in force, longest first. */
  leadDays: number[];
  vendor: { id: string; name: string; status: string } | null;
  owner: Person | null;
  asset: { id: string; code: string; nameEn: string; nameAr: string } | null;
  commonArea: {
    id: string;
    code: string;
    nameEn: string;
    nameAr: string;
  } | null;
}

export interface EvidenceRead {
  evidence: ComplianceEvidence;
  read: PresignedRead | null;
}

export interface OccurrenceRead {
  occurrence: ComplianceOccurrence;
  evidence: EvidenceRead[];
}

export interface ComplianceItemDetail extends ComplianceItemRead {
  /** Its due days, the latest first: the archive. */
  occurrences: OccurrenceRead[];
}

export interface CalendarEntry {
  source: 'compliance' | 'vendor_document' | 'staff_certificate';
  /** The due day's id, the vendor paper's or the staff certificate's. */
  id: string;
  day: LocalDate;
  /**
   * COMPLIANCE_KINDS, the paper's VENDOR_DOCUMENT_KINDS or the
   * certificate's STAFF_CERTIFICATE_KINDS.
   */
  kind: string;
  state: 'valid' | 'due_soon' | 'overdue' | 'done' | 'expired';
  itemId: string | null;
  title: string | null;
  vendorId: string | null;
  vendorName: string | null;
  /** A staff certificate's holder (ADR 0090); null otherwise. */
  holderId: string | null;
  holderName: string | null;
}

export interface StatusCounts {
  items: number;
  valid: number;
  dueSoon: number;
  overdue: number;
  completed: number;
  retired: number;
}

export interface ComplianceReport {
  asOf: LocalDate;
  totals: StatusCounts;
  kinds: (StatusCounts & { kind: ComplianceKind })[];
  /** The vendors' live papers with an expiry (ADR 0077), as they stand. */
  vendorPapers: { valid: number; expiringSoon: number; expired: number };
}

const PAGE = keysetCursor('createdAt', 'asc');
/** The archive a detail shows: the latest due days. */
const ARCHIVE_MAX = 100;
/** The calendar's rows at most. */
const CALENDAR_ROWS = 1000;

const itemNotFound = () =>
  appError.notFound(
    ErrorCode.COMPLIANCE_ITEM_NOT_FOUND,
    'Compliance item not found',
  );
const occurrenceNotFound = () =>
  appError.notFound(
    ErrorCode.COMPLIANCE_OCCURRENCE_NOT_FOUND,
    'Due date not found',
  );
const evidenceNotFound = () =>
  appError.notFound(
    ErrorCode.COMPLIANCE_EVIDENCE_NOT_FOUND,
    'Evidence not found',
  );
const itemRetired = () =>
  appError.conflict(
    ErrorCode.COMPLIANCE_ITEM_RETIRED,
    'This compliance item is retired',
  );
const occurrenceEnded = (status: string) =>
  appError.conflict(
    ErrorCode.COMPLIANCE_OCCURRENCE_ENDED,
    'This due date is done or called off',
    { params: { status } },
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid compliance item', {
    fields,
  });

const STATUS_COLUMNS: CsvColumn[] = [
  { header: 'kind', kind: 'text' },
  { header: 'title', kind: 'text' },
  { header: 'authority', kind: 'text' },
  { header: 'reference', kind: 'text' },
  { header: 'asset', kind: 'text' },
  { header: 'common_area', kind: 'text' },
  { header: 'vendor', kind: 'text' },
  { header: 'state', kind: 'text' },
  { header: 'due_on', kind: 'text' },
  { header: 'last_done_on', kind: 'text' },
  { header: 'expires_on', kind: 'text' },
];

/**
 * The compound's compliance calendar (ADR 0087), kept with
 * `compliance.manage`: what it must keep valid — its fire systems, its
 * lifts, its insurance, its licences and permits — each about an asset of
 * its own, a common area or the compound, with who answers for it (a vendor
 * of the register, a staff member, or both), its due days, every how many
 * months it recurs and how far ahead it is told.
 *
 * One due day is open at a time. Done once, on a day, with what it gave (a
 * certificate's number and its expiry, a note about the work, evidence
 * files): the next one is made in the same transaction, due on the day
 * given, else on that expiry, else so many months on; none for an item done
 * once with nothing that expires. Retired once, with a code: its open due
 * day is called off. The vendors' papers (ADR 0077) show in the calendar and
 * the report where they are, never copied.
 *
 * Locks, in this order: the caller's account and a responsible staff
 * member's (FOR SHARE), the vendor (shared, usable), the item (FOR UPDATE to
 * change it, complete or retire it; FOR SHARE to file evidence), then its
 * due day (FOR UPDATE). Two completions of one due day: the second waits
 * for the item and finds it done (COMPLIANCE_OCCURRENCE_ENDED); a partial
 * unique index keeps one open due day an item behind the lock.
 */
@Injectable()
export class ComplianceService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly vendors: VendorsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(COMPLIANCE_ITEM_RESOURCE, (id) => this.get(id));
  }

  // ---------------------------------------------------------------- reads

  /** In the order they were made; `kind`, `status`, an owner or a vendor narrow it. */
  list(q: {
    kind?: ComplianceKind;
    status?: 'active' | 'retired';
    ownerId?: string;
    vendorId?: string;
    assetId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ComplianceItemRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.complianceItem.findMany({
        where: {
          AND: [
            q.kind ? { kind: q.kind } : {},
            q.status === 'active'
              ? { retiredAt: null }
              : q.status === 'retired'
                ? { retiredAt: { not: null } }
                : {},
            q.ownerId ? { ownerId: q.ownerId } : {},
            q.vendorId ? { vendorId: q.vendorId } : {},
            q.assetId ? { assetId: q.assetId } : {},
            ...(PAGE.after(q.cursor) as Prisma.ComplianceItemWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.reads(tx, items), nextCursor };
    });
  }

  get(id: string): Promise<ComplianceItemDetail> {
    return this.tenantTx.withTenantTx((tx) => this.detail(tx, id));
  }

  /**
   * The compound's days `from` … `to` (at most 366): the due days of its
   * items not called off, and its vendors' live papers expiring then, by
   * day. A vendor's paper is read where it is (ADR 0077), never copied.
   */
  calendarOf(q: { from?: LocalDate; to?: LocalDate }): Promise<{
    from: LocalDate;
    to: LocalDate;
    entries: CalendarEntry[];
    truncated: boolean;
  }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.calendar.now(tx);
      const from = q.from ?? today;
      const to = q.to ?? addDays(from, 89);
      if (to < from)
        throw invalid([
          { field: 'to', code: FieldErrorCode.ENDS_BEFORE_START },
        ]);
      if (daysBetween(from, to) + 1 > CALENDAR_MAX_DAYS)
        throw invalid([
          {
            field: 'to',
            code: FieldErrorCode.PERIOD_TOO_LONG,
            params: { maxDays: CALENDAR_MAX_DAYS },
          },
        ]);
      const leads = await this.compoundLeads(tx);
      const rows = await tx.$queryRaw<
        {
          source: 'compliance' | 'vendor_document' | 'staff_certificate';
          id: string;
          day: Date;
          kind: string;
          status: string;
          item_id: string | null;
          title: string | null;
          lead_days: number[] | null;
          vendor_id: string | null;
          vendor_name: string | null;
          holder_id: string | null;
          holder_name: string | null;
        }[]
      >`
        SELECT * FROM (
          SELECT 'compliance' AS source, o.id, o.due_on AS day, i.kind, o.status,
                 i.id AS item_id, i.title, i.lead_days,
                 i.vendor_id, v.name AS vendor_name,
                 NULL::uuid AS holder_id, NULL::text AS holder_name
            FROM compliance_occurrences o
            JOIN compliance_items i ON i.id = o.item_id
            LEFT JOIN vendors v ON v.id = i.vendor_id
           WHERE o.status <> 'cancelled'
             AND o.due_on >= ${from}::date AND o.due_on <= ${to}::date
          UNION ALL
          SELECT 'vendor_document' AS source, d.id, d.expires_on AS day, d.kind,
                 'open' AS status, NULL::uuid AS item_id, NULL::text AS title,
                 NULL::smallint[] AS lead_days, d.vendor_id, v.name AS vendor_name,
                 NULL::uuid AS holder_id, NULL::text AS holder_name
            FROM vendor_documents d
            JOIN vendors v ON v.id = d.vendor_id
           WHERE d.removed_at IS NULL AND d.expires_on IS NOT NULL
             AND d.expires_on >= ${from}::date AND d.expires_on <= ${to}::date
          UNION ALL
          -- A staff certificate (ADR 0090), live, of an active holder: read
          -- where it is, as a vendor's paper.
          SELECT 'staff_certificate' AS source, c.id, c.expires_on AS day, c.kind,
                 'open' AS status, NULL::uuid AS item_id, c.title,
                 NULL::smallint[] AS lead_days, NULL::uuid AS vendor_id,
                 NULL::text AS vendor_name, a.id AS holder_id, a.full_name AS holder_name
            FROM staff_certificates c
            JOIN accounts a ON a.id = c.account_id AND a.status = 'active'
           WHERE c.removed_at IS NULL
             AND c.expires_on >= ${from}::date AND c.expires_on <= ${to}::date
        ) e
        ORDER BY day, id
        LIMIT ${CALENDAR_ROWS + 1}`;
      const entries = rows.slice(0, CALENDAR_ROWS).map((r): CalendarEntry => {
        const day = ofDateColumn(r.day);
        let state: CalendarEntry['state'];
        if (r.source === 'vendor_document')
          state =
            day < today
              ? 'expired'
              : daysBetween(today, day) <= VENDOR_DOCUMENT_NOTICE_DAYS
                ? 'due_soon'
                : 'valid';
        else if (r.source === 'staff_certificate')
          state =
            day < today
              ? 'expired'
              : daysBetween(today, day) <= CERTIFICATE_NOTICE_DAYS
                ? 'due_soon'
                : 'valid';
        else if (r.status === 'done') state = 'done';
        else state = stateOf(day, today, leadTimes(r.lead_days ?? [], leads));
        return {
          source: r.source,
          id: r.id,
          day,
          kind: r.kind,
          state,
          itemId: r.item_id,
          title: r.title,
          vendorId: r.vendor_id,
          vendorName: r.vendor_name,
          holderId: r.holder_id,
          holderName: r.holder_name,
        };
      });
      return { from, to, entries, truncated: rows.length > CALENDAR_ROWS };
    });
  }

  /** Where every item stands today, per kind, and the vendors' papers. */
  report(): Promise<ComplianceReport> {
    return this.tenantTx.withTenantTx((tx) => this.reportIn(tx));
  }

  /** One row per item not retired, soonest due first. */
  async reportCsv(): Promise<{ name: string; body: Buffer }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.calendar.now(tx);
      const items = await tx.complianceItem.findMany({
        where: { retiredAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const reads = await this.reads(tx, items);
      reads.sort((a, b) => {
        const da = a.current ? ofDateColumn(a.current.dueOn) : '9999-12-31';
        const db = b.current ? ofDateColumn(b.current.dueOn) : '9999-12-31';
        return da < db ? -1 : da > db ? 1 : a.item.id < b.item.id ? -1 : 1;
      });
      return {
        name: `compliance-status-${today}.csv`,
        body: toCsv(
          STATUS_COLUMNS,
          reads.map((r) => [
            r.item.kind,
            r.item.title,
            r.item.authority,
            r.item.reference,
            r.asset?.code ?? null,
            r.commonArea?.code ?? null,
            r.vendor?.name ?? null,
            r.state,
            r.current ? ofDateColumn(r.current.dueOn) : null,
            ofDateColumnOrNull(r.lastDone?.doneOn ?? null),
            ofDateColumnOrNull(r.lastDone?.expiresOn ?? null),
          ]),
        ),
      };
    });
  }

  /** The compound's lead times, longest first. */
  settings(): Promise<{ leadDays: number[] }> {
    return this.tenantTx.withTenantTx(async (tx) => ({
      leadDays: await this.compoundLeads(tx),
    }));
  }

  // ---------------------------------------------------------------- writes

  create(input: ComplianceItemInput): Promise<ComplianceItemDetail> {
    const title = input.title.trim();
    const fields: FieldError[] = [];
    if (!title)
      fields.push({
        field: 'title',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: 120 },
      });
    if (input.assetId && input.commonAreaId)
      fields.push({
        field: 'commonAreaId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (!input.vendorId && !input.ownerId)
      fields.push({ field: 'vendorId', code: FieldErrorCode.FIELD_REQUIRED });
    if (fields.length) throw invalid(fields);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, {
          type: COMPLIANCE_ITEM_RESOURCE,
          id,
        });
        await this.access.lockSelf(tx);
        if (input.ownerId) await this.requireResponsible(tx, input.ownerId);
        if (input.vendorId) await this.vendors.lockUsable(tx, input.vendorId);
        await this.requireSubject(tx, input);
        const { today } = await this.calendar.now(tx);
        this.requireDue('firstDueOn', input.firstDueOn, today);
        const item = await tx.complianceItem.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            kind: input.kind,
            title,
            authority: input.authority?.trim() || null,
            reference: input.reference?.trim() || null,
            assetId: input.assetId ?? null,
            commonAreaId: input.commonAreaId ?? null,
            vendorId: input.vendorId ?? null,
            ownerId: input.ownerId ?? null,
            recurrenceMonths: input.recurrenceMonths ?? null,
            leadDays: normalLeads(input.leadDays ?? []),
            notes: input.notes?.trim() || null,
            createdById: this.ctx.accountId,
          },
        });
        await tx.complianceOccurrence.create({
          data: {
            id: newId(),
            tenantId: this.ctx.tenantId,
            itemId: id,
            dueOn: dateColumn(input.firstDueOn),
          },
        });
        await this.audit.record(tx, {
          action: 'compliance_item.created',
          targetId: id,
          changes: diffChanges(
            null,
            { ...audited(item), dueOn: input.firstDueOn },
            'compliance_item.created',
          ),
        });
        await this.tellOwner(tx, item, input.firstDueOn);
        return id;
      })
      .then((id) => this.get(id));
  }

  update(
    id: string,
    input: ComplianceItemUpdate,
  ): Promise<ComplianceItemDetail> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.access.lockSelf(tx);
        if (input.ownerId) await this.requireResponsible(tx, input.ownerId);
        const before = await this.lockItem(tx, id, 'update');
        if (before.retiredAt) throw itemRetired();
        if (input.vendorId && input.vendorId !== before.vendorId)
          await this.vendors.lockUsable(tx, input.vendorId);
        const next = {
          assetId: input.assetId === undefined ? before.assetId : input.assetId,
          commonAreaId:
            input.commonAreaId === undefined
              ? before.commonAreaId
              : input.commonAreaId,
          vendorId:
            input.vendorId === undefined ? before.vendorId : input.vendorId,
          ownerId: input.ownerId === undefined ? before.ownerId : input.ownerId,
        };
        const fields: FieldError[] = [];
        if (input.title !== undefined && !input.title.trim())
          fields.push({
            field: 'title',
            code: FieldErrorCode.INVALID_LENGTH,
            params: { min: 1, max: 120 },
          });
        if (next.assetId && next.commonAreaId)
          fields.push({
            field: input.assetId ? 'assetId' : 'commonAreaId',
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
          });
        if (!next.vendorId && !next.ownerId)
          fields.push({
            field: input.ownerId === null ? 'ownerId' : 'vendorId',
            code: FieldErrorCode.FIELD_REQUIRED,
          });
        if (fields.length) throw invalid(fields);
        if (
          (input.assetId && input.assetId !== before.assetId) ||
          (input.commonAreaId && input.commonAreaId !== before.commonAreaId)
        )
          await this.requireSubject(tx, {
            assetId: input.assetId ?? undefined,
            commonAreaId: input.commonAreaId ?? undefined,
          });
        const item = await tx.complianceItem.update({
          where: { id },
          data: {
            title: input.title?.trim(),
            authority: text(input.authority),
            reference: text(input.reference),
            assetId: next.assetId,
            commonAreaId: next.commonAreaId,
            vendorId: next.vendorId,
            ownerId: next.ownerId,
            recurrenceMonths: input.recurrenceMonths,
            leadDays:
              input.leadDays === undefined
                ? undefined
                : normalLeads(input.leadDays),
            notes: text(input.notes),
          },
        });
        const changes = diffChanges(
          audited(before),
          audited(item),
          'compliance_item.updated',
        );
        let current = await this.lockOpen(tx, id);
        if (input.nextDueOn !== undefined) {
          if (!current)
            throw invalid([
              { field: 'nextDueOn', code: FieldErrorCode.FIELD_NOT_ALLOWED },
            ]);
          const { today } = await this.calendar.now(tx);
          this.requireDue('nextDueOn', input.nextDueOn, today);
          const was = ofDateColumn(current.dueOn);
          if (was !== input.nextDueOn) {
            current = await tx.complianceOccurrence.update({
              where: { id: current.id },
              // A new day: its notices start again.
              data: {
                dueOn: dateColumn(input.nextDueOn),
                leadAlertedDays: null,
                overdueNotifiedAt: null,
              },
            });
            changes.dueOn = { from: was, to: input.nextDueOn };
          }
        }
        if (Object.keys(changes).length)
          await this.audit.record(tx, {
            action: 'compliance_item.updated',
            targetId: id,
            changes,
          });
        if (item.ownerId && item.ownerId !== before.ownerId && current)
          await this.tellOwner(tx, item, ofDateColumn(current.dueOn));
      })
      .then(() => this.get(id));
  }

  /**
   * The open due day done, once (ADR 0087): on a day not after today (a
   * year back at most), with what it gave and its evidence; the next one is
   * made now, unless nothing recurs or expires.
   */
  complete(
    occurrenceId: string,
    input: CompletionInput,
  ): Promise<ComplianceItemDetail> {
    if (input.expiresOn !== undefined && input.expiresOn <= input.doneOn)
      throw invalid([
        { field: 'expiresOn', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    const fileIds = [...new Set(input.fileIds ?? [])];
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.access.lockSelf(tx);
        const seen = await tx.complianceOccurrence.findUnique({
          where: { id: occurrenceId },
          select: { itemId: true },
        });
        if (!seen) throw occurrenceNotFound();
        const item = await this.lockItem(tx, seen.itemId, 'update');
        if (item.retiredAt) throw itemRetired();
        const occurrence = await this.lockOccurrence(tx, occurrenceId);
        if (occurrence.status !== 'open')
          throw occurrenceEnded(occurrence.status);
        const { now, today } = await this.calendar.now(tx);
        const fields: FieldError[] = [];
        if (input.doneOn > today || input.doneOn < earliestDone(today))
          fields.push({
            field: 'doneOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { from: earliestDone(today), to: today },
          });
        const next = nextDueOn({
          dueOn: ofDateColumn(occurrence.dueOn),
          recurrenceMonths: item.recurrenceMonths,
          expiresOn: input.expiresOn,
          nextDueOn: input.nextDueOn,
        });
        if (input.nextDueOn !== undefined && input.nextDueOn <= input.doneOn)
          fields.push({
            field: 'nextDueOn',
            code: FieldErrorCode.ENDS_BEFORE_START,
          });
        else if (next !== null && next > latestDue(today))
          fields.push({
            field: input.nextDueOn ? 'nextDueOn' : 'expiresOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { to: latestDue(today) },
          });
        if (fields.length) throw invalid(fields);
        await tx.complianceOccurrence.update({
          where: { id: occurrenceId },
          data: {
            status: 'done',
            doneOn: dateColumn(input.doneOn),
            doneAt: now,
            doneById: this.ctx.accountId,
            certificateNumber: input.certificateNumber?.trim() || null,
            expiresOn: input.expiresOn ? dateColumn(input.expiresOn) : null,
            note: input.note?.trim() || null,
          },
        });
        for (const fileId of fileIds)
          await this.attachEvidence(tx, occurrenceId, fileId, now, 'fileIds');
        let nextId: string | null = null;
        if (next !== null) {
          nextId = newId();
          await tx.complianceOccurrence.create({
            data: {
              id: nextId,
              tenantId: item.tenantId,
              itemId: item.id,
              dueOn: dateColumn(next),
              previousId: occurrenceId,
            },
          });
        }
        await this.audit.record(tx, {
          action: 'compliance_item.completed',
          targetId: item.id,
          metadata: {
            occurrenceId,
            dueOn: ofDateColumn(occurrence.dueOn),
            doneOn: input.doneOn,
            expiresOn: input.expiresOn ?? null,
            nextOccurrenceId: nextId,
            nextDueOn: next,
            files: fileIds.length,
            certificateNumber: input.certificateNumber !== undefined,
            note: input.note !== undefined,
          },
        });
        return item.id;
      })
      .then((itemId) => this.get(itemId));
  }

  /** A file filed on a due day, open or done: the archive. At most EVIDENCE_MAX live. */
  addEvidence(occurrenceId: string, fileId: string): Promise<OccurrenceRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.complianceOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { itemId: true },
      });
      if (!seen) throw occurrenceNotFound();
      await this.lockItem(tx, seen.itemId, 'share');
      const occurrence = await this.lockOccurrence(tx, occurrenceId);
      if (occurrence.status === 'cancelled')
        throw occurrenceEnded(occurrence.status);
      const id = await this.attachEvidence(
        tx,
        occurrenceId,
        fileId,
        await dbNow(tx),
        'fileId',
      );
      await this.audit.record(tx, {
        action: 'compliance_item.evidence_added',
        targetId: seen.itemId,
        metadata: { occurrenceId, evidenceId: id },
      });
      return this.occurrenceRead(tx, occurrence);
    });
  }

  /** Filed by mistake: the row stays, its file goes. */
  removeEvidence(evidenceId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.complianceEvidence.findUnique({
        where: { id: evidenceId },
      });
      if (!seen) throw evidenceNotFound();
      const occurrence = await tx.complianceOccurrence.findUniqueOrThrow({
        where: { id: seen.occurrenceId },
        select: { itemId: true },
      });
      await this.lockItem(tx, occurrence.itemId, 'share');
      await this.lockOccurrence(tx, seen.occurrenceId);
      await tx.$queryRaw`SELECT id FROM compliance_evidence WHERE id = ${evidenceId}::uuid FOR UPDATE`;
      const evidence = await tx.complianceEvidence.findUniqueOrThrow({
        where: { id: evidenceId },
      });
      if (evidence.removedAt !== null) throw evidenceNotFound();
      await tx.complianceEvidence.update({
        where: { id: evidenceId },
        data: { removedAt: await dbNow(tx), removedById: this.ctx.accountId },
      });
      await this.files.markDeleted(
        tx,
        { id: evidence.fileId, purpose: 'compliance_evidence' },
        'withdrawn',
      );
      await this.audit.record(tx, {
        action: 'compliance_item.evidence_removed',
        targetId: occurrence.itemId,
        metadata: { occurrenceId: seen.occurrenceId, evidenceId },
      });
    });
  }

  /** Retired once, with a code: its open due day is called off. */
  retire(
    id: string,
    reasonCode: string | undefined,
  ): Promise<ComplianceItemDetail> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.complianceRetire,
    );
    return this.tenantTx
      .withTenantTx(async (tx) => {
        await this.access.lockSelf(tx);
        const item = await this.lockItem(tx, id, 'update');
        if (item.retiredAt) throw itemRetired();
        const now = await dbNow(tx);
        const open = await this.lockOpen(tx, id);
        if (open)
          await tx.complianceOccurrence.update({
            where: { id: open.id },
            data: {
              status: 'cancelled',
              cancelledAt: now,
              cancelledById: this.ctx.accountId,
            },
          });
        await tx.complianceItem.update({
          where: { id },
          data: {
            retiredAt: now,
            retiredById: this.ctx.accountId,
            retireReason: reason,
          },
        });
        await this.audit.record(tx, {
          action: 'compliance_item.retired',
          targetId: id,
          metadata: { reasonCode: reason, occurrenceId: open?.id ?? null },
        });
      })
      .then(() => this.get(id));
  }

  /** The compound's lead times: one to three, 1 to 365 days each. */
  updateSettings(leadDays: number[]): Promise<{ leadDays: number[] }> {
    const leads = normalLeads(leadDays);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.compoundLeads(tx);
      const row = await tx.complianceSettings.upsert({
        where: { tenantId: this.ctx.tenantId },
        create: {
          tenantId: this.ctx.tenantId,
          leadDays: leads,
          updatedById: this.ctx.accountId,
        },
        update: { leadDays: leads, updatedById: this.ctx.accountId },
      });
      if (before.join(',') !== leads.join(','))
        await this.audit.record(tx, {
          action: 'compliance.settings_changed',
          targetId: this.ctx.tenantId,
          changes: {
            leadDays: { from: before.join(','), to: leads.join(',') },
          },
        });
      return { leadDays: normalLeads(row.leadDays) };
    });
  }

  // ------------------------------------------------------------- the sweep

  /** Open due days within the longest lead time or past, not told yet. */
  async dueOnes(
    tx: TenantTxClient,
    tenantId: string,
    limit: number,
  ): Promise<string[]> {
    const { today } = await this.calendar.now(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH s AS (
        SELECT coalesce((SELECT lead_days FROM compliance_settings
                          WHERE tenant_id = ${tenantId}::uuid),
                        ${[...DEFAULT_LEAD_DAYS]}::smallint[]) AS leads)
      SELECT o.id
        FROM compliance_occurrences o
        JOIN compliance_items i ON i.id = o.item_id
        CROSS JOIN s
       WHERE o.status = 'open' AND i.retired_at IS NULL
         AND ((o.due_on < ${today}::date AND o.overdue_notified_at IS NULL)
           OR (o.due_on >= ${today}::date
               AND o.due_on - ${today}::date <= (
                     SELECT max(x) FROM unnest(
                       CASE WHEN cardinality(i.lead_days) > 0 THEN i.lead_days ELSE s.leads END) x)
               AND (o.lead_alerted_days IS NULL
                    OR o.due_on - ${today}::date < o.lead_alerted_days)))
       ORDER BY o.due_on, o.id
       LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /**
   * One due day: its lead time or its passing told once, to its
   * responsible staff member and who keeps the calendar, under the item's
   * (shared) and its own lock, deciding by what it reads after them.
   */
  async alert(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    const seen = await tx.complianceOccurrence.findUnique({
      where: { id },
      select: { itemId: true },
    });
    if (!seen) return 0;
    const item = await this.lockItem(tx, seen.itemId, 'share');
    const occurrence = await this.lockOccurrence(tx, id);
    if (item.retiredAt || occurrence.status !== 'open') return 0;
    const { now, today } = await this.calendar.now(tx, tenantId);
    const dueOn = ofDateColumn(occurrence.dueOn);
    const leads = leadTimes(
      item.leadDays,
      await this.compoundLeads(tx, tenantId),
    );
    let kind: 'compliance.due_soon' | 'compliance.overdue';
    let params: Record<string, string | number>;
    if (dueOn < today) {
      if (occurrence.overdueNotifiedAt) return 0;
      await tx.complianceOccurrence.update({
        where: { id },
        data: { overdueNotifiedAt: now },
      });
      kind = 'compliance.overdue';
      params = { complianceKind: item.kind, dueOn };
    } else {
      const left = daysBetween(today, dueOn);
      const within = leads.filter((l) => left <= l);
      if (!within.length) return 0;
      const stage = Math.min(...within);
      if (
        occurrence.leadAlertedDays !== null &&
        stage >= occurrence.leadAlertedDays
      )
        return 0;
      await tx.complianceOccurrence.update({
        where: { id },
        data: { leadAlertedDays: stage },
      });
      kind = 'compliance.due_soon';
      params = { complianceKind: item.kind, dueOn, daysLeft: left };
    }
    const to = new Set(
      (await this.staff.holding(tx, 'compliance.manage')).map((k) => k.id),
    );
    if (item.ownerId) {
      const owner = await tx.account.findFirst({
        where: { id: item.ownerId, status: 'active' },
        select: { id: true },
      });
      if (owner) to.add(owner.id);
    }
    await this.notifier.notify(tx, [...to], {
      kind,
      params,
      targetId: item.id,
    });
    return 1;
  }

  // ------------------------------------------------------------ internals

  async reportIn(tx: TenantTxClient): Promise<ComplianceReport> {
    const { today } = await this.calendar.now(tx);
    const leads = await this.compoundLeads(tx);
    const rows = await tx.$queryRaw<
      {
        kind: string | null;
        total: number;
        items: number;
        valid: number;
        due_soon: number;
        overdue: number;
        completed: number;
        retired: number;
      }[]
    >`
      SELECT i.kind, GROUPING(i.kind)::int AS total,
             count(*) FILTER (WHERE i.retired_at IS NULL)::int AS items,
             count(*) FILTER (WHERE i.retired_at IS NULL AND o.due_on IS NOT NULL
                                AND o.due_on - ${today}::date > l.lead)::int AS valid,
             count(*) FILTER (WHERE i.retired_at IS NULL AND o.due_on >= ${today}::date
                                AND o.due_on - ${today}::date <= l.lead)::int AS due_soon,
             count(*) FILTER (WHERE i.retired_at IS NULL
                                AND o.due_on < ${today}::date)::int AS overdue,
             count(*) FILTER (WHERE i.retired_at IS NULL AND o.id IS NULL)::int AS completed,
             count(*) FILTER (WHERE i.retired_at IS NOT NULL)::int AS retired
        FROM compliance_items i
        LEFT JOIN compliance_occurrences o
          ON o.item_id = i.id AND o.status = 'open'
        CROSS JOIN LATERAL (
          SELECT coalesce(max(x), 0) AS lead FROM unnest(
            CASE WHEN cardinality(i.lead_days) > 0 THEN i.lead_days
                 ELSE ${leads}::smallint[] END) x) l
       GROUP BY ROLLUP (i.kind)`;
    const [papers] = await tx.$queryRaw<
      { valid: number; expiring: number; expired: number }[]
    >`
      SELECT count(*) FILTER (WHERE expires_on - ${today}::date > ${VENDOR_DOCUMENT_NOTICE_DAYS}::int)::int AS valid,
             count(*) FILTER (WHERE expires_on >= ${today}::date
                                AND expires_on - ${today}::date <= ${VENDOR_DOCUMENT_NOTICE_DAYS}::int)::int AS expiring,
             count(*) FILTER (WHERE expires_on < ${today}::date)::int AS expired
        FROM vendor_documents
       WHERE removed_at IS NULL AND expires_on IS NOT NULL`;
    const counts = (r: (typeof rows)[number] | undefined): StatusCounts => ({
      items: r?.items ?? 0,
      valid: r?.valid ?? 0,
      dueSoon: r?.due_soon ?? 0,
      overdue: r?.overdue ?? 0,
      completed: r?.completed ?? 0,
      retired: r?.retired ?? 0,
    });
    const byKind = new Map(
      rows.filter((r) => r.total === 0).map((r) => [r.kind!, r]),
    );
    return {
      asOf: today,
      totals: counts(rows.find((r) => r.total === 1)),
      kinds: COMPLIANCE_KINDS.map((kind) => ({
        kind,
        ...counts(byKind.get(kind)),
      })),
      vendorPapers: {
        valid: papers?.valid ?? 0,
        expiringSoon: papers?.expiring ?? 0,
        expired: papers?.expired ?? 0,
      },
    };
  }

  private async compoundLeads(
    tx: TenantTxClient,
    tenantId = this.ctx.tenantId,
  ): Promise<number[]> {
    const row = await tx.complianceSettings.findUnique({
      where: { tenantId },
      select: { leadDays: true },
    });
    return normalLeads(row?.leadDays ?? DEFAULT_LEAD_DAYS);
  }

  private async attachEvidence(
    tx: TenantTxClient,
    occurrenceId: string,
    fileId: string,
    at: Date,
    field: string,
  ): Promise<string> {
    const live = await tx.complianceEvidence.count({
      where: { occurrenceId, removedAt: null },
    });
    if (live >= EVIDENCE_MAX)
      throw appError.conflict(
        ErrorCode.MAINTENANCE_DOCUMENT_LIMIT_REACHED,
        'No more files here',
        { params: { max: EVIDENCE_MAX } },
      );
    const file = await this.files.claim(tx, fileId, 'compliance_evidence');
    if (!file)
      throw invalid([{ field, code: FieldErrorCode.FILE_NOT_AVAILABLE }]);
    await this.files.attach(tx, file);
    const id = newId();
    await tx.complianceEvidence.create({
      data: {
        id,
        tenantId: this.ctx.tenantId,
        occurrenceId,
        fileId: file.id,
        addedById: this.ctx.accountId,
        addedAt: at,
      },
    });
    return id;
  }

  private async detail(
    tx: TenantTxClient,
    id: string,
  ): Promise<ComplianceItemDetail> {
    const item = await tx.complianceItem.findUnique({ where: { id } });
    if (!item) throw itemNotFound();
    const [read] = await this.reads(tx, [item]);
    const occurrences = await tx.complianceOccurrence.findMany({
      where: { itemId: id },
      orderBy: [{ dueOn: 'desc' }, { id: 'desc' }],
      take: ARCHIVE_MAX,
    });
    const out: OccurrenceRead[] = [];
    for (const o of occurrences) out.push(await this.occurrenceRead(tx, o));
    return { ...read, occurrences: out };
  }

  private async occurrenceRead(
    tx: TenantTxClient,
    occurrence: ComplianceOccurrence,
  ): Promise<OccurrenceRead> {
    const evidence = await tx.complianceEvidence.findMany({
      where: { occurrenceId: occurrence.id, removedAt: null },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
    const reads: EvidenceRead[] = [];
    for (const e of evidence)
      reads.push({ evidence: e, read: await this.files.readUrl(tx, e.fileId) });
    return { occurrence, evidence: reads };
  }

  private async reads(
    tx: TenantTxClient,
    items: ComplianceItem[],
  ): Promise<ComplianceItemRead[]> {
    if (!items.length) return [];
    const ids = items.map((i) => i.id);
    const { today } = await this.calendar.now(tx);
    const leads = await this.compoundLeads(tx);
    const open = await tx.complianceOccurrence.findMany({
      where: { itemId: { in: ids }, status: 'open' },
    });
    const done = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (item_id) id FROM compliance_occurrences
       WHERE item_id = ANY(${ids}::uuid[]) AND status = 'done'
       ORDER BY item_id, done_on DESC, done_at DESC, id DESC`;
    const lastDone = done.length
      ? await tx.complianceOccurrence.findMany({
          where: { id: { in: done.map((d) => d.id) } },
        })
      : [];
    const vendors = new Map(
      (
        await tx.vendor.findMany({
          where: {
            id: { in: items.flatMap((i) => (i.vendorId ? [i.vendorId] : [])) },
          },
          select: { id: true, name: true, status: true },
        })
      ).map((v) => [v.id, v]),
    );
    const people = new Map(
      (
        await tx.account.findMany({
          where: {
            id: { in: items.flatMap((i) => (i.ownerId ? [i.ownerId] : [])) },
          },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    const assets = new Map(
      (
        await tx.asset.findMany({
          where: {
            id: { in: items.flatMap((i) => (i.assetId ? [i.assetId] : [])) },
          },
          select: { id: true, code: true, nameEn: true, nameAr: true },
        })
      ).map((a) => [a.id, a]),
    );
    const areas = new Map(
      (
        await tx.commonArea.findMany({
          where: {
            id: {
              in: items.flatMap((i) =>
                i.commonAreaId ? [i.commonAreaId] : [],
              ),
            },
          },
          select: { id: true, code: true, nameEn: true, nameAr: true },
        })
      ).map((a) => [a.id, a]),
    );
    return items.map((item) => {
      const current = open.find((o) => o.itemId === item.id) ?? null;
      const own = leadTimes(item.leadDays, leads);
      const state: ComplianceState = item.retiredAt
        ? 'retired'
        : current
          ? stateOf(ofDateColumn(current.dueOn), today, own)
          : 'completed';
      return {
        item,
        current,
        lastDone: lastDone.find((o) => o.itemId === item.id) ?? null,
        state,
        leadDays: own,
        vendor: item.vendorId ? (vendors.get(item.vendorId) ?? null) : null,
        owner: item.ownerId
          ? (people.get(item.ownerId) ?? {
              id: item.ownerId,
              fullName: null,
              status: 'erased',
            })
          : null,
        asset: item.assetId ? (assets.get(item.assetId) ?? null) : null,
        commonArea: item.commonAreaId
          ? (areas.get(item.commonAreaId) ?? null)
          : null,
      };
    });
  }

  private async lockItem(
    tx: TenantTxClient,
    id: string,
    mode: 'update' | 'share',
  ): Promise<ComplianceItem> {
    if (mode === 'update')
      await tx.$queryRaw`SELECT id FROM compliance_items WHERE id = ${id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM compliance_items WHERE id = ${id}::uuid FOR SHARE`;
    const item = await tx.complianceItem.findUnique({ where: { id } });
    if (!item) throw itemNotFound();
    return item;
  }

  private async lockOccurrence(
    tx: TenantTxClient,
    id: string,
  ): Promise<ComplianceOccurrence> {
    await tx.$queryRaw`SELECT id FROM compliance_occurrences WHERE id = ${id}::uuid FOR UPDATE`;
    const occurrence = await tx.complianceOccurrence.findUnique({
      where: { id },
    });
    if (!occurrence) throw occurrenceNotFound();
    return occurrence;
  }

  /** The item's open due day, FOR UPDATE; the item's lock is held. */
  private async lockOpen(
    tx: TenantTxClient,
    itemId: string,
  ): Promise<ComplianceOccurrence | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM compliance_occurrences
       WHERE item_id = ${itemId}::uuid AND status = 'open' FOR UPDATE`;
    return row ? this.lockOccurrence(tx, row.id) : null;
  }

  /** From today, ten years ahead at most. */
  private requireDue(field: string, day: LocalDate, today: LocalDate): void {
    if (day < today || day > latestDue(today))
      throw invalid([
        {
          field,
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { from: today, to: latestDue(today) },
        },
      ]);
  }

  /** An active staff member or the manager, shared-locked. */
  private async requireResponsible(
    tx: TenantTxClient,
    ownerId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${ownerId}::uuid FOR SHARE`;
    const ok = await tx.account.count({
      where: {
        id: ownerId,
        status: 'active',
        type: { in: ['staff', 'manager'] },
      },
    });
    if (!ok)
      throw invalid([
        { field: 'ownerId', code: FieldErrorCode.RESPONSIBLE_NOT_ELIGIBLE },
      ]);
  }

  /** An asset of the compound's own (not a unit's), not retired; an active common area. */
  private async requireSubject(
    tx: TenantTxClient,
    s: { assetId?: string; commonAreaId?: string },
  ): Promise<void> {
    if (s.assetId) {
      await tx.$queryRaw`SELECT id FROM assets WHERE id = ${s.assetId}::uuid FOR SHARE`;
      const ok = await tx.asset.count({
        where: { id: s.assetId, unitId: null, status: { not: 'retired' } },
      });
      if (!ok)
        throw invalid([
          {
            field: 'assetId',
            code: FieldErrorCode.COMPLIANCE_ASSET_NOT_AVAILABLE,
          },
        ]);
    }
    if (s.commonAreaId) {
      const ok = await tx.commonArea.count({
        where: { id: s.commonAreaId, active: true },
      });
      if (!ok)
        throw invalid([
          {
            field: 'commonAreaId',
            code: FieldErrorCode.COMMON_AREA_NOT_AVAILABLE,
          },
        ]);
    }
  }

  /** The responsible staff member told it is theirs, unless they did it. */
  private async tellOwner(
    tx: TenantTxClient,
    item: ComplianceItem,
    dueOn: LocalDate,
  ): Promise<void> {
    if (!item.ownerId || item.ownerId === this.ctx.accountId) return;
    await this.notifier.notify(tx, [item.ownerId], {
      kind: 'compliance_item.assigned',
      params: { complianceKind: item.kind, dueOn },
      targetId: item.id,
    });
  }
}

/** A patch's text: undefined keeps it, null or blank clears it. */
function text(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v?.trim() || null;
}

const audited = (i: ComplianceItem) => ({
  kind: i.kind,
  title: i.title,
  authority: i.authority,
  reference: i.reference,
  assetId: i.assetId,
  commonAreaId: i.commonAreaId,
  vendorId: i.vendorId,
  ownerId: i.ownerId,
  recurrenceMonths: i.recurrenceMonths,
  leadDays: i.leadDays.join(','),
  notes: i.notes,
});
