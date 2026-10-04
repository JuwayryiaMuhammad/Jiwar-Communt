import { ApiProperty } from '@nestjs/swagger';
import {
  DispatchOutcome,
  DispatchTrigger,
  type TicketDispatchAttempt,
} from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  erased,
} from '../../../core/common/http/personal';
import type { AutoAssignment } from '../../tickets/dispatch.service';
import type { HistoryRead } from '../../tickets/tickets.service';

/** One run of the dispatch engine on a ticket: why it was (not) assigned. */
export class DispatchAttemptView {
  @ApiProperty({ enum: DispatchTrigger, enumName: 'DispatchTrigger' })
  trigger: DispatchTrigger;
  @ApiProperty({ enum: DispatchOutcome, enumName: 'DispatchOutcome' })
  outcome: DispatchOutcome;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({
    type: Number,
    description: 'Technicians who could have taken it.',
  })
  candidateCount: number;
  @ApiProperty({ type: AccountRefView, nullable: true })
  technician: AccountRefView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it did nothing (`skipped` only).',
  })
  reasonCode: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'This run told the dispatchers it is unassignable.',
  })
  notified: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static list(h: HistoryRead<TicketDispatchAttempt>): DispatchAttemptView[] {
    return h.rows.map((r) => {
      const p = r.technicianId ? h.people.get(r.technicianId) : undefined;
      return {
        trigger: r.trigger,
        outcome: r.outcome,
        cycle: r.cycle,
        candidateCount: r.candidateCount,
        technician: r.technicianId
          ? p
            ? accountRef(p)
            : erased(r.technicianId)
          : null,
        reasonCode: r.reasonCode,
        notified: r.notified,
        at: r.createdAt,
      };
    });
  }
}

/** What an automatic assignment request did. */
export class AutoAssignmentView {
  @ApiProperty({ enum: ['assigned', 'no_candidate'] })
  outcome: 'assigned' | 'no_candidate';
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Who got it; null when nobody could take it.',
  })
  technician: AccountRefView | null;

  static from(a: AutoAssignment): AutoAssignmentView {
    return {
      outcome: a.outcome,
      technician: a.technician ? accountRef(a.technician) : null,
    };
  }
}
