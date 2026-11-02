import { ApiProperty } from '@nestjs/swagger';
import type { ClosedUnitRound } from '@prisma/client';
import { ROUND_STATUSES, type ClosedUnitRead } from '../closed-units.service';

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A closed unit's round (ADR 0083). */
export class ClosedUnitRoundView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date', description: 'Its due day.' })
  dueOn: string;
  @ApiProperty({ enum: ROUND_STATUSES })
  status: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The closed-unit inspection task that carries it out.',
  })
  taskId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ClosedUnitRound): ClosedUnitRoundView {
    return {
      id: r.id,
      dueOn: day(r.dueOn),
      status: r.status,
      taskId: r.taskId,
      createdAt: r.createdAt,
    };
  }
}

export class ClosedUnitInspectionView {
  @ApiProperty({ type: String, format: 'uuid' })
  taskId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  doneAt: Date;
  @ApiProperty({ type: String, description: '`all_clear` or `issue_found`.' })
  outcome: string;
}

export class ClosedUnitRequestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'IR-000004' })
  reference: string;
  @ApiProperty({ enum: ['open', 'scheduled'] })
  status: string;
}

/**
 * A unit in closed mode, as the management's list shows it (ADR 0083): its
 * code and building, never who lives there.
 */
export class ClosedUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  closedSince: Date;
  @ApiProperty({
    type: ClosedUnitInspectionView,
    nullable: true,
    description: 'The newest inspection done since it closed.',
  })
  lastInspection: ClosedUnitInspectionView | null;
  @ApiProperty({
    type: ClosedUnitRequestView,
    nullable: true,
    description: 'An owner’s or a proxy’s request still open or scheduled.',
  })
  openRequest: ClosedUnitRequestView | null;
  @ApiProperty({
    type: ClosedUnitRoundView,
    nullable: true,
    description: 'Its live round, due or scheduled.',
  })
  round: ClosedUnitRoundView | null;
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'The day its next round falls due: the compound’s days between rounds after it closed or was last inspected.',
  })
  nextRoundOn: string;
  @ApiProperty({ type: Number, description: 'Invited or active proxies.' })
  liveProxies: number;

  static from(u: ClosedUnitRead): ClosedUnitView {
    return {
      unitId: u.unitId,
      unitCode: u.unitCode,
      building: u.building,
      closedSince: u.closedSince,
      lastInspection: u.lastInspection,
      openRequest: u.openRequest,
      round: u.round ? ClosedUnitRoundView.from(u.round) : null,
      nextRoundOn: u.nextRoundOn,
      liveProxies: u.liveProxies,
    };
  }
}
