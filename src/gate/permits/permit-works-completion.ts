import { Injectable, type OnModuleInit } from '@nestjs/common';
import { WorksCompletions } from '../../core/works/works-completions';
import { worksCertificateNumber } from './permit-inspections.service';

/**
 * A unit's works completion, as finance reads it (ADR 0063): the newest
 * passed completion inspection of a works permit of the unit, decided at
 * or after the given instant.
 */
@Injectable()
export class PermitWorksCompletion implements OnModuleInit {
  constructor(private readonly works: WorksCompletions) {}

  onModuleInit(): void {
    this.works.register(async (tx, q) => {
      const permits = await tx.unitPermit.findMany({
        where: { unitId: q.unitId, kind: 'works' },
        select: { id: true },
      });
      if (!permits.length) return null;
      const passed = await tx.permitInspection.findFirst({
        where: {
          permitId: { in: permits.map((p) => p.id) },
          status: 'passed',
          decidedAt: { gte: q.since },
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
