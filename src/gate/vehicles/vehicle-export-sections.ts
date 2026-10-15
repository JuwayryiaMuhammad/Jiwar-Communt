import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { dayOf, reference } from './vehicle-rules';

/**
 * The vehicles and parking sections of a personal-data export (ADR 0045),
 * `vehicles/`:
 * - `vehicles.json`: the vehicles the account registered (removed ones
 *   too), and the current ones of each unit where it keeps vehicles:
 *   `reference`, `unitCode`, `plate`, `makeAndModel`, `color`, `type`,
 *   `status`, `permitValidUntil`, `stickerNumber`, `registeredByMe`,
 *   `createdAt`, `removedAt`, and whether it has a licence photo (the
 *   photo is the vehicle's, not the account's file: an export carries
 *   the account's own files only, ADR 0036);
 * - `visitor-parking-bookings.json`: the bookings it made, with the
 *   visitor's name while it lasts;
 * - `fines.json`: the fines of each unit whose fines it sees and those it
 *   appealed, with its own appeal's words; payments only where it sees
 *   the unit's money;
 * - `parking-reports.json`: its own reports, open or closed, never whom
 *   they matched or what became of them.
 * Nobody else's name.
 */
@Injectable()
export class VehicleExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.sections.register('vehicles', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const data = await this.tenantTx.withTenantTx(async (tx) => {
      const keeps = await this.community.unitsWhere(tx, me, 'vehicles');
      const money = await this.community.unitsWhere(tx, me, 'financeView');
      const vehicles = await tx.vehicle.findMany({
        where: {
          OR: [
            { registeredById: me },
            { unitId: { in: keeps }, status: { not: 'removed' } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const bookings = await tx.visitorParkingBooking.findMany({
        where: { bookedById: me },
        include: { area: { select: { name: true } } },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      });
      const fines = await tx.vehicleFine.findMany({
        where: {
          OR: [
            { unitId: { in: [...new Set([...keeps, ...money])] } },
            { appealedById: me },
          ],
        },
        include: {
          payments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const reports = await tx.parkingReport.findMany({
        where: { reporterId: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const codes = await this.community.unitCodes(tx, [
        ...vehicles.map((v) => v.unitId),
        ...bookings.map((b) => b.unitId),
        ...fines.map((f) => f.unitId),
      ]);
      return { vehicles, bookings, fines, reports, codes, money };
    });
    const { codes } = data;
    yield {
      path: 'vehicles/vehicles.json',
      json: data.vehicles.map((v) => ({
        reference: reference('V', v.number),
        unitCode: codes.get(v.unitId) ?? null,
        plate: v.plate,
        makeAndModel: v.makeAndModel,
        color: v.color,
        type: v.type,
        status: v.status,
        permitValidUntil: dayOf(v.permitValidUntil),
        stickerNumber: v.stickerNumber,
        registeredByMe: v.registeredById === me,
        licencePhoto: v.licencePhotoFileId !== null,
        createdAt: v.createdAt,
        removedAt: v.removedAt,
      })),
    };
    yield {
      path: 'vehicles/visitor-parking-bookings.json',
      json: data.bookings.map((b) => ({
        reference: reference('P', b.number),
        unitCode: codes.get(b.unitId) ?? null,
        areaName: b.area.name,
        visitorPassId: b.visitorPassId,
        visitorName: b.visitorName,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        status: b.status,
        cancelReason: b.cancelReason,
        createdAt: b.createdAt,
      })),
    };
    yield {
      path: 'vehicles/fines.json',
      json: data.fines.map((f) => ({
        reference: reference('F', f.number),
        unitCode: codes.get(f.unitId) ?? null,
        plate: f.plate,
        reason: f.reason,
        note: f.note,
        amount: f.amount.toFixed(2),
        currency: f.currency,
        date: dayOf(f.occurredOn),
        status: f.status,
        appeal:
          f.appealedAt && f.appealedById === me
            ? {
                reason: f.appealText,
                appealedAt: f.appealedAt,
                decision: f.appealDecision,
              }
            : null,
        cancelReason: f.cancelReason,
        payments: data.money.includes(f.unitId)
          ? f.payments.map((p) => ({
              kind: p.kind,
              amount: p.amount?.toFixed(2) ?? null,
              receiptNumber: p.receiptNumber,
              paidOn: dayOf(p.paidOn),
              reasonCode: p.reasonCode,
              createdAt: p.createdAt,
            }))
          : null,
        createdAt: f.createdAt,
      })),
    };
    yield {
      path: 'vehicles/parking-reports.json',
      json: data.reports.map((r) => ({
        reference: reference('R', r.number),
        plate: r.plate,
        location: r.location,
        note: r.note,
        status: r.status === 'open' ? 'open' : 'closed',
        createdAt: r.createdAt,
      })),
    };
  }
}
