import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { safetyReference, seriesOf } from './safety-rules';

/**
 * The emergencies and gate services section of a personal-data export
 * (ADR 0047), `safety/`:
 * - `emergencies.json`: `reported`, those the account reported — type,
 *   status, unit, times, the close's code, how many of the family were
 *   told; `alerted`, those it was only alerted to — codes and times only,
 *   with its own "on my way". Never who reported, never who responded;
 * - `gate-services.json`: its own requests, with what it wrote while it
 *   lasts and whether there is a photo (the photo is the request's, not
 *   the account's file: an export carries the account's own files only,
 *   ADR 0036). Never security's notes or names.
 */
@Injectable()
export class SafetyExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.sections.register('safety', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const data = await this.tenantTx.withTenantTx(async (tx) => {
      const reported = await tx.emergency.findMany({
        where: { reportedById: me },
        orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
      });
      const alerts = await tx.emergencyFamilyAlert.findMany({
        where: { accountId: me },
        orderBy: [{ notifiedAt: 'asc' }, { emergencyId: 'asc' }],
      });
      const alerted = new Map(
        (
          await tx.emergency.findMany({
            where: { id: { in: alerts.map((a) => a.emergencyId) } },
          })
        ).map((e) => [e.id, e]),
      );
      const families = await tx.emergencyFamilyAlert.groupBy({
        by: ['emergencyId'],
        where: { emergencyId: { in: reported.map((e) => e.id) } },
        _count: { _all: true },
      });
      const requests = await tx.gateServiceRequest.findMany({
        where: { requestedById: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const places = new Map(
        (
          await tx.place.findMany({
            where: {
              id: {
                in: requests.flatMap((r) =>
                  [r.fromPlaceId, r.toPlaceId, r.placeId].filter(
                    (p): p is string => p !== null,
                  ),
                ),
              },
            },
          })
        ).map((p) => [p.id, p.nameEn]),
      );
      const gates = new Map(
        (
          await tx.gate.findMany({
            where: {
              id: { in: requests.flatMap((r) => (r.gateId ? [r.gateId] : [])) },
            },
            select: { id: true, name: true },
          })
        ).map((g) => [g.id, g.name]),
      );
      const codes = await this.community.unitCodes(tx, [
        ...reported.map((e) => e.unitId),
        ...[...alerted.values()].map((e) => e.unitId),
        ...requests.map((r) => r.unitId),
      ]);
      return {
        reported,
        alerts,
        alerted,
        families: new Map(families.map((f) => [f.emergencyId, f._count._all])),
        requests,
        places,
        gates,
        codes,
      };
    });
    const { codes, places } = data;
    const placeName = (id: string | null) =>
      (id ? places.get(id) : null) ?? null;
    yield {
      path: 'safety/emergencies.json',
      json: {
        reported: data.reported.map((e) => ({
          reference: safetyReference('E', e.number),
          type: e.type,
          status: e.status,
          unitCode: codes.get(e.unitId) ?? null,
          reportedAt: e.reportedAt,
          acceptedAt: e.acceptedAt,
          arrivedAt: e.arrivedAt,
          closedAt: e.closedAt,
          closeReason: e.closeReason,
          familyNotified: data.families.get(e.id) ?? 0,
        })),
        alerted: data.alerts.flatMap((a) => {
          const e = data.alerted.get(a.emergencyId);
          return e
            ? [
                {
                  reference: safetyReference('E', e.number),
                  type: e.type,
                  status: e.status,
                  unitCode: codes.get(e.unitId) ?? null,
                  alertedAt: a.notifiedAt,
                  onMyWayAt: a.onMyWayAt,
                },
              ]
            : [];
        }),
      },
    };
    yield {
      path: 'safety/gate-services.json',
      json: data.requests.map((r) => ({
        reference: safetyReference(seriesOf(r.kind).prefix, r.number),
        kind: r.kind,
        status: r.status,
        unitCode: codes.get(r.unitId) ?? null,
        assistanceKind: r.assistanceKind,
        forHouseholdMember: r.memberId !== null,
        from: placeName(r.fromPlaceId),
        to: placeName(r.toPlaceId),
        place: placeName(r.placeId),
        when: r.whenCode,
        wantedAt: r.wantedAt,
        description: r.description,
        photo: r.photoFileId !== null,
        laneReason: r.laneReason,
        gate: r.gateId ? (data.gates.get(r.gateId) ?? null) : null,
        notes: r.notes,
        createdAt: r.createdAt,
        acceptedAt: r.acceptedAt,
        closedAt: r.closedAt,
        closeReason: r.closeReason,
        cancelledAt: r.cancelledAt,
      })),
    };
  }
}
