import { Injectable, type OnModuleInit } from '@nestjs/common';
import { WorksDeposits } from '../../core/works/works-deposits';

/**
 * What finance asks the gate about the works permit a finishing-works
 * deposit names (ADR 0074): the permit's unit, for a works permit only,
 * and how many of its damage claims are still open (a refund waits).
 */
@Injectable()
export class PermitWorksDeposits implements OnModuleInit {
  constructor(private readonly deposits: WorksDeposits) {}

  onModuleInit(): void {
    this.deposits.registerPermits({
      unitOf: async (tx, permitId) => {
        const permit = await tx.unitPermit.findUnique({
          where: { id: permitId },
          select: { unitId: true, kind: true },
        });
        return permit?.kind === 'works' ? permit.unitId : null;
      },
      openClaims: (tx, permitId) =>
        tx.permitDamageClaim.count({
          where: { permitId, status: { in: ['open', 'under_appeal'] } },
        }),
    });
  }
}
