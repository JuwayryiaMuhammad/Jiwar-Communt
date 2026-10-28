import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MoveSteps } from '../../core/moves/move-steps';
import { formatNumber } from '../counters';
import { heldOf } from '../deposits/deposits.service';
import { ZERO } from '../money';

/**
 * A move-out's checklist reads finance here (ADR 0063): a clearance of the
 * unit issued since the notice, and whether the deposits the management
 * holds for the occupancy hold nothing any more (none is settled too).
 */
@Injectable()
export class FinanceMoveSteps implements OnModuleInit {
  constructor(private readonly steps: MoveSteps) {}

  onModuleInit(): void {
    this.steps.register('clearance_issued', async (tx, move) => {
      const clearance = await tx.financeClearance.findFirst({
        where: { unitId: move.unitId, asOf: { gte: move.createdAt } },
        orderBy: { asOf: 'desc' },
        select: { number: true, asOf: true },
      });
      return clearance
        ? {
            done: true,
            at: clearance.asOf,
            reference: formatNumber('clearance', clearance.number),
          }
        : { done: false, at: null, reference: null };
    });
    this.steps.register('deposits_settled', async (tx, move) => {
      const deposits = await tx.financeDeposit.findMany({
        where: { occupancyId: move.occupancyId },
        include: { events: true },
      });
      const holding = deposits.some((d) => heldOf(d).gt(ZERO));
      const last = deposits
        .flatMap((d) => d.events)
        .reduce<Date | null>((at, e) => (at && at > e.at ? at : e.at), null);
      return holding
        ? { done: false, at: null, reference: null }
        : { done: true, at: deposits.length ? last : null, reference: null };
    });
  }
}
