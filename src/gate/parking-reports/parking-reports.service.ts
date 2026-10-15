import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Account, ParkingReport, Prisma } from '@prisma/client';
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
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import { normalizePlate, PLATE_MAX } from '../../core/common/vehicle-plate';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FinesService, type NewFine } from '../fines/fines.service';
import { VehicleCore } from '../vehicles/vehicle-core';
import {
  dayOf,
  permitStatus,
  type PermitStatus,
} from '../vehicles/vehicle-rules';
import { MyParkingReportView } from './views/parking-report.views';

export const PARKING_REPORT_RESOURCE = 'parking_report';
/** A resident has at most this many open reports. */
export const MAX_OPEN_REPORTS = 10;

export const LOCATION = { min: 1, max: 120 } as const;
export const REPORT_NOTE = { min: 1, max: 500 } as const;

type Person = Pick<Account, 'id' | 'fullName' | 'status'>;

/** What a plate matches among the units' vehicles: for the staff only. */
export interface ReportMatch {
  vehicleId: string;
  unitId: string;
  unitCode: string;
  permitStatus: PermitStatus;
}

export interface StaffReport {
  report: ParkingReport;
  reporter: Person;
  handledBy: Person | null;
  photoUrl: string | null;
  matches: ReportMatch[];
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });
const reportNotFound = () =>
  appError.notFound(
    ErrorCode.PARKING_REPORT_NOT_FOUND,
    'Parking report not found',
  );

const QUEUE = keysetCursor('createdAt', 'asc');
const PAGE = keysetCursor('createdAt', 'desc');

function clean(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Parking reports (ADR 0045). A resident (`parking.report`, living in or a
 * member of a unit) reports a wrongly parked vehicle: a plate, where, a
 * note and a photo. It is about a plate, never a unit, and the reporter is
 * told nothing of whom it matches. Security (`parking_reports.handle`)
 * sees the reporter and the plate's matches, and closes the report with a
 * reason code or turns it into a fine (with `fines.issue`). The fine
 * carries nothing of the report: the reported unit never learns who
 * reported, and the report's photo stays the reporter's.
 */
@Injectable()
export class ParkingReportsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly community: CommunityGatePort,
    private readonly core: VehicleCore,
    private readonly fines: FinesService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PARKING_REPORT_RESOURCE, async (id) =>
      MyParkingReportView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.parkingReport.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /**
   * Files a report: at most 10 open per resident, counted under their own
   * reports' lock. The answer is the same whether the plate matches
   * anything or not.
   */
  create(input: {
    plate: string;
    location: string;
    note?: string;
    photoFileId?: string;
  }): Promise<ParkingReport> {
    const fields: FieldError[] = [];
    const plate = normalizePlate(input.plate);
    if (!plate)
      fields.push({
        field: 'plate',
        code: FieldErrorCode.INVALID_FORMAT,
        params: { maxLength: PLATE_MAX },
      });
    const location = clean(input.location);
    if (!location || location.length > LOCATION.max)
      fields.push({
        field: 'location',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...LOCATION },
      });
    const note = input.note !== undefined ? clean(input.note) : null;
    if (note !== null && (!note || note.length > REPORT_NOTE.max))
      fields.push({
        field: 'note',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...REPORT_NOTE },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PARKING_REPORT_RESOURCE, id });
      await this.core.lockSelf(tx);
      const me = this.ctx.accountId;
      const places = await this.community.unitsWhere(tx, me, 'unitView');
      if (!places.length)
        throw appError.forbidden(
          ErrorCode.PARKING_REPORT_NOT_ALLOWED,
          'Only the compound’s residents report parking',
        );
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`parking-report:${this.ctx.txTenantId}:${me}`}))`;
      const open = await tx.parkingReport.count({
        where: { reporterId: me, status: 'open' },
      });
      if (open >= MAX_OPEN_REPORTS)
        throw appError.conflict(
          ErrorCode.PARKING_REPORT_LIMIT_REACHED,
          'Too many open parking reports',
          { params: { max: MAX_OPEN_REPORTS } },
        );
      let photo: string | null = null;
      if (input.photoFileId) {
        const file = await this.files.claim(
          tx,
          input.photoFileId,
          'parking_photo',
        );
        if (!file)
          throw invalid([
            { field: 'photoFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ]);
        await this.files.attach(tx, file);
        photo = file.id;
      }
      const number = await this.core.nextNumber(tx, 'parking_report');
      const report = await tx.parkingReport.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          reporterId: me,
          plate: plate!,
          location,
          note,
          photoFileId: photo,
        },
      });
      await this.audit.record(tx, {
        action: 'parking_report.created',
        targetId: id,
        metadata: { number, note: note !== null, photo: photo !== null },
      });
      return report;
    });
  }

  /** The caller's own reports, newest first. */
  mine(q: { cursor?: string; limit?: number }): Promise<Page<ParkingReport>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.parkingReport.findMany({
        where: {
          AND: [
            { reporterId: this.ctx.accountId },
            ...(PAGE.after(q.cursor) as Prisma.ParkingReportWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  // --------------------------------------------------------------------------
  // Security
  // --------------------------------------------------------------------------

  list(q: {
    status?: 'open' | 'closed' | 'converted';
    cursor?: string;
    limit?: number;
  }): Promise<Page<StaffReport>> {
    const limit = clampLimit(q.limit);
    const page = q.status === 'open' ? QUEUE : PAGE;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.parkingReport.findMany({
        where: {
          AND: [
            ...(q.status ? [{ status: q.status }] : []),
            ...(page.after(q.cursor) as Prisma.ParkingReportWhereInput[]),
          ],
        },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = page.toPage(rows, limit);
      const out: StaffReport[] = [];
      for (const r of items) out.push(await this.staffReport(tx, r));
      return { items: out, nextCursor };
    });
  }

  get(id: string): Promise<StaffReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const report = await tx.parkingReport.findUnique({ where: { id } });
      if (!report) throw reportNotFound();
      return this.staffReport(tx, report);
    });
  }

  close(id: string, reasonCode: string | undefined): Promise<StaffReport> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.parkingReportClose,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.lockOpen(tx, id);
      const closed = await tx.parkingReport.update({
        where: { id },
        data: {
          status: 'closed',
          closeReason: reason,
          handledById: this.ctx.accountId,
          handledAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'parking_report.closed',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      return this.staffReport(tx, closed);
    });
  }

  /**
   * Turns an open report into a fine, issued as any fine is: nothing of
   * the report goes on it — not the reporter, not the report's photo, not
   * a link. The report points at the fine; the fine never at the report.
   */
  convert(id: string, input: NewFine): Promise<StaffReport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.lockOpen(tx, id);
      const fineId = newId();
      await this.fines.issueIn(tx, fineId, input);
      const converted = await tx.parkingReport.update({
        where: { id },
        data: {
          status: 'converted',
          fineId,
          handledById: this.ctx.accountId,
          handledAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'parking_report.converted',
        targetId: id,
        metadata: { fineId },
      });
      return this.staffReport(tx, converted);
    });
  }

  private async lockOpen(
    tx: TenantTxClient,
    id: string,
  ): Promise<ParkingReport> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM parking_reports WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw reportNotFound();
    const report = await tx.parkingReport.findUniqueOrThrow({ where: { id } });
    if (report.status !== 'open')
      throw appError.conflict(
        ErrorCode.PARKING_REPORT_CLOSED,
        'The report was handled already',
        { params: { status: report.status } },
      );
    return report;
  }

  private async staffReport(
    tx: TenantTxClient,
    report: ParkingReport,
  ): Promise<StaffReport> {
    const ids = [report.reporterId, report.handledById].filter(
      (x): x is string => x !== null,
    );
    const people = new Map(
      (
        await tx.account.findMany({
          where: { id: { in: ids } },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    const vehicles = await tx.vehicle.findMany({
      where: {
        plateKey: report.plateKey,
        status: { in: ['pending', 'active'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const codes = await this.core.unitCodes(
      tx,
      vehicles.map((v) => v.unitId),
    );
    const { today } = await this.core.clock(tx);
    return {
      report,
      reporter: people.get(report.reporterId)!,
      handledBy: report.handledById
        ? (people.get(report.handledById) ?? null)
        : null,
      photoUrl: (await this.files.readUrl(tx, report.photoFileId))?.url ?? null,
      matches: vehicles.map((v) => ({
        vehicleId: v.id,
        unitId: v.unitId,
        unitCode: codes.get(v.unitId) ?? '',
        permitStatus: permitStatus(v.status, dayOf(v.permitValidUntil), today),
      })),
    };
  }
}
