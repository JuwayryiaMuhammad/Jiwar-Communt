import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { WorksCompletions } from '../../core/works/works-completions';
import { worksCertificateNumber } from './permit-inspections.service';
import { startOfDay } from './permits.service';

/**
 * A unit's works completion, as finance reads it (ADR 0063): the newest
 * passed completion inspection of a works permit of the unit, decided on
 * or after the given local day: from the start of that day in the
 * compound's time zone.
 */
@Injectable()
export class PermitWorksCompletion implements OnModuleInit {
  constructor(
    private readonly works: WorksCompletions,
    private readonly settings: TenantSettingsService,
  ) {}

  onModuleInit(): void {
    this.works.register(async (tx, q) => {
      const permits = await tx.unitPermit.findMany({
        where: { unitId: q.unitId, kind: 'works' },
        select: { id: true },
      });
      if (!permits.length) return null;
      const { timezone } = await this.settings.inTx(tx, q.tenantId);
      const passed = await tx.permitInspection.findFirst({
        where: {
          permitId: { in: permits.map((p) => p.id) },
          status: 'passed',
          decidedAt: { gte: startOfDay(q.since, timezone) },
        },
        orderBy: { decidedAt: 'desc' },
        select: { decidedAt: true, certificateNumber: true },
      });
      return passed
        ? {
            at: passed.decidedAt!,
            reference: worksCertificateNumber(passed.certificateNumber!),
          }
        : null;
    });
  }
}
