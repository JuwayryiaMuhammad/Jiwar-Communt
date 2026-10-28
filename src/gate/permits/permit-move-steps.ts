import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MoveSteps } from '../../core/moves/move-steps';
import { permitReference } from './permit-core';

/**
 * A move's checklist reads its permit here (ADR 0063): the latest move
 * permit that serves the move and was approved (or used).
 */
@Injectable()
export class PermitMoveSteps implements OnModuleInit {
  constructor(private readonly steps: MoveSteps) {}

  onModuleInit(): void {
    this.steps.register('move_permit', async (tx, move) => {
      const permit = await tx.unitPermit.findFirst({
        where: { moveId: move.id, status: { in: ['approved', 'used'] } },
        orderBy: { createdAt: 'desc' },
        select: { kind: true, number: true, decidedAt: true },
      });
      return permit
        ? {
            done: true,
            at: permit.decidedAt,
            reference: permitReference(permit.kind, permit.number),
          }
        : { done: false, at: null, reference: null };
    });
  }
}
