import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';

export const VISITOR_DATA_SWEEP = 'gate.visitor_data';

/**
 * Visitor retention (ADR 0028), compound by compound:
 * - a pass past its end is `expired` and its code is destroyed;
 * - a visitor's name and phone are deleted when they expire (30 days after
 *   the pass or the gate request); the passes, requests and entries stay,
 *   and the names in the notifications about them are scrubbed.
 * Idempotent: every step only touches what is still due.
 */
@Injectable()
export class VisitorDataSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(VISITOR_DATA_SWEEP, (now) => this.run(now));
  }

  run(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const expired = await tx.visitorPass.updateMany({
        where: { status: 'active', validUntil: { lte: now } },
        data: { status: 'expired', codeHash: null },
      });
      const due = await tx.visitorDetails.findMany({
        where: { expiresAt: { lte: now } },
        select: { id: true },
      });
      if (!due.length) return expired.count;
      const ids = due.map((d) => d.id);
      const passes = await tx.visitorPass.findMany({
        where: { visitorDetailsId: { in: ids } },
        select: { id: true },
      });
      await this.notifier.scrubPersonal(
        tx,
        passes.map((p) => p.id),
      );
      const { count } = await tx.visitorDetails.deleteMany({
        where: { id: { in: ids } },
      });
      return expired.count + count;
    });
  }
}
