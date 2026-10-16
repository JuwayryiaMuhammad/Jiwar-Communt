import { Injectable } from '@nestjs/common';
import { PermissionsService } from '../../core/access/permissions.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { GateServiceHandlersService } from '../gate-services/gate-service-handlers.service';
import { StaffGateServiceView } from '../gate-services/views/gate-service.views';
import { ParkingReportsService } from '../parking-reports/parking-reports.service';
import { StaffParkingReportView } from '../parking-reports/views/parking-report.views';
import { ShiftsService } from '../shifts/shifts.service';
import { TasksService } from './tasks.service';
import type { MyWorkView } from './views/my-work.views';

/** How many of each kind the work list shows; `total` counts them all. */
export const MY_WORK_LIMIT = 50;

/**
 * A guard's work in one place (ADR 0050). Nothing is rebuilt: the gate
 * services and the parking reports are read through their own services
 * and views, each in its own transaction; acting on one goes through its
 * own routes.
 */
@Injectable()
export class MyWorkService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly permissions: PermissionsService,
    private readonly shifts: ShiftsService,
    private readonly tasks: TasksService,
    private readonly gateServices: GateServiceHandlersService,
    private readonly parkingReports: ParkingReportsService,
  ) {}

  async mine(): Promise<MyWorkView> {
    const me = this.ctx.accountId;
    const { duty, tasks, queueTotal, mineTotal, reportsTotal } =
      await this.tenantTx.withTenantTx(async (tx) => {
        const duty = await this.shifts.onDuty(tx, me);
        return {
          duty,
          tasks: await this.tasks.workOf(tx, me, duty, MY_WORK_LIMIT),
          queueTotal: await tx.gateServiceRequest.count({
            where: { status: 'open' },
          }),
          mineTotal: await tx.gateServiceRequest.count({
            where: {
              status: { in: ['accepted', 'in_progress'] },
              handledById: me,
            },
          }),
          reportsTotal: await tx.parkingReport.count({
            where: { status: 'open' },
          }),
        };
      });
    const view = (r: Parameters<typeof StaffGateServiceView.from>[0]) =>
      StaffGateServiceView.from(r, me);
    const queue = duty
      ? await this.gateServices.list({ status: 'open', limit: MY_WORK_LIMIT })
      : null;
    const accepted = duty
      ? await this.gateServices.list({
          status: ['accepted', 'in_progress'],
          handledById: me,
          limit: MY_WORK_LIMIT,
        })
      : null;
    const reports = (await this.permissions.current()).has(
      'parking_reports.handle',
    )
      ? await this.parkingReports.list({ status: 'open', limit: MY_WORK_LIMIT })
      : null;
    return {
      onShift: duty !== null,
      tasks: { data: tasks.items, total: tasks.total },
      gateServiceQueue: queue
        ? { data: queue.items.map(view), total: queueTotal }
        : null,
      myGateServices: accepted
        ? { data: accepted.items.map(view), total: mineTotal }
        : null,
      parkingReports: reports
        ? {
            // A guard's work: the reporter by first name.
            data: reports.items.map((r) =>
              StaffParkingReportView.from(r, true),
            ),
            total: reportsTotal,
          }
        : null,
    };
  }
}
