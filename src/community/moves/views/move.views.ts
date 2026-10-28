import { ApiProperty } from '@nestjs/swagger';
import { MOVE_DIRECTIONS } from '../move-checklist';
import type {
  BoardMove,
  ChecklistStep,
  MoveRead,
  MoveWithChecklist,
} from '../moves.service';

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A move in or out of a unit (ADR 0063). */
export class MoveView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: '`MV-` and the number.' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  occupancyId: string;
  @ApiProperty({ enum: MOVE_DIRECTIONS })
  direction: string;
  @ApiProperty({ type: String, format: 'date' })
  plannedOn: string;
  @ApiProperty({ enum: ['planned', 'done', 'cancelled'] })
  status: string;
  @ApiProperty({
    type: Boolean,
    description: 'False when the occupancy’s start planned it.',
  })
  plannedBySomeone: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A move-out handed over with no clearance: why (a code).',
  })
  handoverReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;

  static from(m: MoveRead): MoveView {
    return {
      id: m.id,
      reference: `MV-${String(m.number).padStart(6, '0')}`,
      unitId: m.unitId,
      occupancyId: m.occupancyId,
      direction: m.direction,
      plannedOn: day(m.plannedOn),
      status: m.status,
      plannedBySomeone: m.plannedBySomeone,
      createdAt: m.createdAt,
      doneAt: m.doneAt,
      handoverReason: m.handoverReason,
      cancelledAt: m.cancelledAt,
      cancelReason: m.cancelReason,
    };
  }
}

/** A move on the management's board. */
export class BoardMoveView extends MoveView {
  @ApiProperty({ type: String })
  unitCode: string;

  static fromBoard(m: BoardMove): BoardMoveView {
    return { ...MoveView.from(m), unitCode: m.unitCode };
  }
}

/** A step of a move's checklist. */
export class ChecklistStepView {
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({
    enum: ['resident', 'management', 'derived'],
    description:
      '`derived`: read from where it lives (a permit, a request, a clearance, the deposits).',
  })
  side: string;
  @ApiProperty({ type: Boolean })
  done: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  at: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A derived step’s reference, e.g. the permit’s number.',
  })
  reference: string | null;

  static from(s: ChecklistStep): ChecklistStepView {
    return { ...s };
  }
}

export class MoveDetailView {
  @ApiProperty({ type: MoveView })
  move: MoveView;
  @ApiProperty({ type: [ChecklistStepView] })
  checklist: ChecklistStepView[];

  static from(m: MoveWithChecklist): MoveDetailView {
    return {
      move: MoveView.from(m.move),
      checklist: m.checklist.map((s) => ChecklistStepView.from(s)),
    };
  }
}
