import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { dbNow } from '../db-clock';
import { permitReference } from './permit-core';
import { viewStatus } from './permit-records';
import { timeOf } from './permit-rules';

/**
 * The permits section of a personal-data export (ADR 0049), `permits/`:
 * `permits.json`, the permits the account asked for — kind, status, unit,
 * dates, the decision's codes, what it wrote while it lasts, its workers'
 * and guests' names while they last, the truck's plate, and whether there
 * was a photo. Never the last four of an ID (only a hash is kept), never a
 * face or a photo (the permit's files, not the account's: ADR 0036), never
 * the management's notes, never who decided or which guard.
 */
@Injectable()
export class PermitExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.sections.register('permits', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const data = await this.tenantTx.withTenantTx(async (tx) => {
      const permits = await tx.unitPermit.findMany({
        where: { requestedById: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const ids = permits.map((p) => p.id);
      return {
        permits,
        workers: await tx.permitWorker.findMany({
          where: { permitId: { in: ids } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        guests: await tx.permitGuest.findMany({
          where: { permitId: { in: ids } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        codes: await this.community.unitCodes(
          tx,
          permits.map((p) => p.unitId),
        ),
        now: await dbNow(tx),
      };
    });
    yield {
      path: 'permits/permits.json',
      json: data.permits.map((p) => ({
        reference: permitReference(p.kind, p.number),
        kind: p.kind,
        status: viewStatus(p, data.now),
        unitCode: data.codes.get(p.unitId) ?? null,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        createdAt: p.createdAt,
        decidedAt: p.decidedAt,
        decisionSource: p.decisionSource,
        rejectReason: p.rejectReason,
        revokedAt: p.revokedAt,
        revokeReason: p.revokeReason,
        cancelledAt: p.cancelledAt,
        cancelledBy: p.cancelSide,
        cancelReason: p.cancelReason,
        works:
          p.kind === 'works'
            ? {
                workType: p.workType,
                dailyHours: {
                  from: timeOf(p.dailyFrom!),
                  to: timeOf(p.dailyTo!),
                },
                contractorCompany: p.contractorCompany,
                description: p.description,
                workers: data.workers
                  .filter((w) => w.permitId === p.id)
                  .map((w) => ({
                    fullName: w.fullName,
                    idType: w.idType,
                    addedAt: w.createdAt,
                    removedAt: w.removedAt,
                  })),
              }
            : null,
        move:
          p.kind === 'move'
            ? { truckPlate: p.truckPlate, itemsDescription: p.itemsDescription }
            : null,
        materialExit:
          p.kind === 'material_exit'
            ? {
                items: p.items,
                photo: p.photoFileId !== null,
                usedAt: p.usedAt,
              }
            : null,
        event:
          p.kind === 'event'
            ? {
                title: p.title,
                guestLimit: p.guestLimit,
                guests: data.guests
                  .filter((g) => g.permitId === p.id)
                  .map((g) => ({
                    fullName: g.fullName,
                    vehiclePlate: g.vehiclePlate,
                    removedAt: g.removedAt,
                  })),
              }
            : null,
      })),
    };
  }
}
