import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { DelegationsService } from '../households/delegations.service';
import { MemberPermissionsService } from '../households/member-permissions.service';
import { ResidentsService } from './residents.service';
import {
  MyDelegationView,
  MyPermissionsView,
  MyUnitView,
} from './views/me-units.views';

/**
 * The community's sections of a personal-data export (ADR 0036), as the
 * account's own views show them:
 * - `units.json`: `GET /me/units` (occupancies, then memberships);
 * - `permissions/<unitCode>.json`: a member's own permissions on each unit,
 *   `GET /me/units/{unitId}/permissions`;
 * - `delegations.json`: `GET /me/delegations`;
 * - `workers.json`: the domestic workers the account registered, with
 *   exactly `engagementId`, `unitCode`, `workerName` (the name on the
 *   worker's record), `capacity`, `schedule`, `validUntil`, `status`,
 *   `createdAt`, `updatedAt` and `monthlyWage` (ADR 0037: the wage the
 *   account set as the employer) — never the worker's ID number, birth
 *   date, phone, document or photo;
 * - `wage-payments.json`: the wage payments the account recorded itself
 *   (ADR 0037), with exactly `paymentId`, `engagementId`, `unitCode`,
 *   `workerName`, `period` (`YYYY-MM`), `amount` and `paidAt`. A payment
 *   someone else recorded for the same worker is theirs, not here.
 */
@Injectable()
export class CommunityExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly residents: ResidentsService,
    private readonly permissions: MemberPermissionsService,
    private readonly delegations: DelegationsService,
  ) {}

  onModuleInit(): void {
    this.sections.register('units', () => this.units());
    this.sections.register('delegations', () => this.myDelegations());
    this.sections.register('workers', (s) => this.workers(s));
    this.sections.register('wage-payments', (s) => this.wagePayments(s));
  }

  private async *units(): AsyncIterable<ExportEntry> {
    const units = await this.residents.myUnits();
    yield { path: 'units.json', json: units.map((u) => MyUnitView.from(u)) };
    for (const u of units) {
      if (u.capacity !== 'member') continue;
      yield {
        path: `permissions/${u.code}.json`,
        json: MyPermissionsView.from(
          await this.permissions.myPermissions(u.unitId),
        ),
      };
    }
  }

  private async *myDelegations(): AsyncIterable<ExportEntry> {
    yield {
      path: 'delegations.json',
      json: (await this.delegations.mine()).map((d) =>
        MyDelegationView.from(d),
      ),
    };
  }

  private async *workers(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.workerEngagement.findMany({
        where: { requestedById: s.accountId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          capacity: true,
          schedule: true,
          validUntil: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          monthlyWage: true,
          unit: { select: { code: true } },
          worker: { select: { fullName: true } },
        },
      }),
    );
    yield {
      path: 'workers.json',
      json: rows.map((e) => ({
        engagementId: e.id,
        unitCode: e.unit.code,
        workerName: e.worker.fullName,
        capacity: e.capacity,
        schedule: e.schedule,
        validUntil: e.validUntil,
        status: e.status,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        monthlyWage: e.monthlyWage?.toFixed(2) ?? null,
      })),
    };
  }

  /** Payments keep ids only (append-only, no foreign keys): joined here. */
  private async *wagePayments(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx(async (tx) => {
      const payments = await tx.workerWagePayment.findMany({
        where: { paidById: s.accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const engagements = await tx.workerEngagement.findMany({
        where: {
          id: { in: [...new Set(payments.map((p) => p.engagementId))] },
        },
        select: {
          id: true,
          unit: { select: { code: true } },
          worker: { select: { fullName: true } },
        },
      });
      return payments.map((p) => {
        const e = engagements.find((x) => x.id === p.engagementId);
        return {
          paymentId: p.id,
          engagementId: p.engagementId,
          unitCode: e?.unit.code ?? null,
          workerName: e?.worker.fullName ?? null,
          period: p.period.toISOString().slice(0, 7),
          amount: p.amount.toFixed(2),
          paidAt: p.createdAt,
        };
      });
    });
    yield { path: 'wage-payments.json', json: rows };
  }
}
