import { ApiProperty } from '@nestjs/swagger';
import {
  DeliveryInstruction,
  VisitorInstruction,
  VisitorPassKind,
} from '@prisma/client';
import type { GateInstructions } from '../instructions.service';
import type {
  IssuedPass,
  PassListItem,
  PassStatus,
} from '../visitor-passes.service';
import { VisitScheduleDto } from '../dto/visitors.dto';

const STATUSES = ['active', 'used', 'cancelled', 'expired'];

/** Right after creation: the code, shown once (no-store). */
export class IssuedPassView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '6 digits. Null only on a replay of a pass no longer active.',
  })
  code: string | null;

  @ApiProperty({ enum: VisitorPassKind, enumName: 'VisitorPassKind' })
  kind: VisitorPassKind;

  @ApiProperty({ type: Number })
  partySize: number;

  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  validUntil: Date;

  @ApiProperty({ type: VisitScheduleDto, nullable: true })
  schedule: VisitScheduleDto | null;

  @ApiProperty({ enum: STATUSES })
  status: PassStatus;

  static from(p: IssuedPass): IssuedPassView {
    return {
      id: p.id,
      code: p.code,
      kind: p.kind,
      partySize: p.partySize,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      schedule: p.schedule,
      status: p.status,
    };
  }
}

export class PassView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ enum: VisitorPassKind, enumName: 'VisitorPassKind' })
  kind: VisitorPassKind;

  @ApiProperty({ type: Number })
  partySize: number;

  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  validUntil: Date;

  @ApiProperty({ type: VisitScheduleDto, nullable: true })
  schedule: VisitScheduleDto | null;

  @ApiProperty({ enum: STATUSES })
  status: PassStatus;

  @ApiProperty({ type: Boolean, description: 'The caller is the host.' })
  mine: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "On the caller's own passes only, until the data expires.",
  })
  visitorName: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(p: PassListItem): PassView {
    return {
      id: p.id,
      kind: p.kind,
      partySize: p.partySize,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      schedule: p.schedule,
      status: p.status,
      mine: p.mine,
      visitorName: p.visitorName,
      createdAt: p.createdAt,
    };
  }
}

export class GateInstructionsView {
  @ApiProperty({ enum: VisitorInstruction, enumName: 'VisitorInstruction' })
  uninvitedVisitor: VisitorInstruction;

  @ApiProperty({ enum: DeliveryInstruction, enumName: 'DeliveryInstruction' })
  delivery: DeliveryInstruction;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null: never set (the defaults apply).',
  })
  updatedAt: Date | null;

  static from(i: GateInstructions): GateInstructionsView {
    return {
      uninvitedVisitor: i.uninvitedVisitor,
      delivery: i.delivery,
      updatedAt: i.updatedAt,
    };
  }
}
