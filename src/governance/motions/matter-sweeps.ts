import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { ApprovalsService } from '../approvals/approvals.service';
import { MotionsService } from './motions.service';

export const BOARD_MATTERS_SWEEP = 'governance.board_matters';
const INTERVAL_MS = 60_000;

/**
 * The board's matters, every minute (ADR 0055), one item per transaction:
 * - an open motion whose board no longer sits (its term ended or lapsed)
 *   lapses; the matter waits for a motion of the board that sits;
 * - a request past its deadline undecided tells the board and the manager,
 *   once.
 * Each takes its row SKIP LOCKED: a vote in flight holds it, and the next
 * run takes it.
 */
@Injectable()
export class MatterSweeps implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly motions: MotionsService,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(BOARD_MATTERS_SWEEP, (now) => this.run(now), {
      intervalMs: INTERVAL_MS,
    });
  }

  async run(now: Date): Promise<number> {
    const lapsed = await this.sweep.forEachTenantItem(
      (tx) => this.motions.lapsedDue(tx, now),
      (tx, _tenantId, id) => this.motions.lapseOne(tx, id, now),
    );
    const overdue = await this.sweep.forEachTenantItem(
      (tx) => this.approvals.overdueDue(tx, now),
      (tx, _tenantId, id) => this.approvals.notifyOverdue(tx, id, now),
    );
    return lapsed + overdue;
  }
}
