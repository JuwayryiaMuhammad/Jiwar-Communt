import { ApiProperty } from '@nestjs/swagger';
import type { UtilityOutage } from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';
import { OUTAGE_SCOPES } from '../outage-rules';

export class OutageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: REASON_CODES.outageKind, enumName: 'OutageKind' })
  kind: string;
  @ApiProperty({ type: Boolean })
  planned: boolean;
  @ApiProperty({ enum: OUTAGE_SCOPES, enumName: 'OutageScope' })
  scope: string;
  @ApiProperty({
    type: [String],
    description: 'None for the whole compound.',
  })
  buildings: string[];
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Its residents were first told then.',
  })
  notifiedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.outageCancel,
    enumName: 'OutageCancelReason',
    nullable: true,
  })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(o: UtilityOutage): OutageView {
    return {
      id: o.id,
      kind: o.kind,
      planned: o.planned,
      scope: o.scope,
      buildings: o.buildings,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      note: o.note,
      notifiedAt: o.notifiedAt,
      endedAt: o.endedAt,
      cancelledAt: o.cancelledAt,
      cancelReason: o.cancelReason,
      createdAt: o.createdAt,
    };
  }
}

/** An outage as a resident told of it reads it (ADR 0066). */
export class MyOutageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: REASON_CODES.outageKind, enumName: 'OutageKind' })
  kind: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;

  static from(o: UtilityOutage): MyOutageView {
    return {
      id: o.id,
      kind: o.kind,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      note: o.note,
    };
  }
}
