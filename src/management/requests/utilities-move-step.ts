import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MoveSteps } from '../../core/moves/move-steps';
import { requestNumber } from './request-rules';

/** The topic a resident moving in asks utilities on (ADR 0063). */
export const UTILITIES_TOPIC = 'utilities';

/**
 * A move-in's checklist reads here whether the mover asked the management
 * to switch the utilities on (ADR 0063): a request of theirs on the topic
 * `utilities` about the unit, made since the move was planned.
 */
@Injectable()
export class UtilitiesMoveStep implements OnModuleInit {
  constructor(private readonly steps: MoveSteps) {}

  onModuleInit(): void {
    this.steps.register('utilities_requested', async (tx, move) => {
      const request = await tx.managementRequest.findFirst({
        where: {
          unitId: move.unitId,
          authorId: move.accountId,
          topic: { key: UTILITIES_TOPIC },
          createdAt: { gte: move.createdAt },
        },
        orderBy: { createdAt: 'asc' },
        select: { number: true, createdAt: true },
      });
      return request
        ? {
            done: true,
            at: request.createdAt,
            reference: requestNumber(request.number),
          }
        : { done: false, at: null, reference: null };
    });
  }
}
