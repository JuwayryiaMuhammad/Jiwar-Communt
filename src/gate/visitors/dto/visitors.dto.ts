import { ApiProperty } from '@nestjs/swagger';
import {
  DeliveryInstruction,
  VisitorInstruction,
  VisitorPassKind,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';

const PARTY = { min: 1, max: 50 };

export class VisitWindowDto {
  @ApiProperty({ type: String, example: '18:00' })
  from: string;
  @ApiProperty({
    type: String,
    example: '23:00',
    description: 'Before `from`: an overnight window.',
  })
  to: string;
}

export class VisitScheduleDto {
  @ApiProperty({ type: [Number], description: '0 (Sunday) … 6.' })
  days: number[];
  @ApiProperty({ type: [VisitWindowDto] })
  windows: VisitWindowDto[];
}

export class CreateVisitorPassDto {
  @ApiProperty({ enum: VisitorPassKind, enumName: 'VisitorPassKind' })
  @IsEnum(
    VisitorPassKind,
    withParams({ allowed: Object.values(VisitorPassKind) }),
  )
  kind: VisitorPassKind;

  @ApiProperty({ type: Number, minimum: PARTY.min, maximum: PARTY.max })
  @IsInt(withParams(PARTY))
  @Min(PARTY.min, withParams(PARTY))
  @Max(PARTY.max, withParams(PARTY))
  partySize: number;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  validFrom: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'At most 7 days after `validFrom` (one-time), 180 (recurring).',
  })
  @Type(() => Date)
  @IsDate()
  validUntil: Date;

  @ApiProperty({
    type: VisitScheduleDto,
    required: false,
    description: 'Recurring passes only; checked by the service.',
  })
  @IsOptional()
  @IsObject()
  schedule?: VisitScheduleDto;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 200,
    description: 'Shown to the host only; deleted 30 days after the pass ends.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  visitorName?: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'Never returned after creation; deleted with the name.',
  })
  @IsOptional()
  @IsPhone()
  visitorPhone?: string;
}

export class CancelVisitorPassDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `visitorPassCancel`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class GateInstructionsDto {
  @ApiProperty({ enum: VisitorInstruction, enumName: 'VisitorInstruction' })
  @IsEnum(
    VisitorInstruction,
    withParams({ allowed: Object.values(VisitorInstruction) }),
  )
  uninvitedVisitor: VisitorInstruction;

  @ApiProperty({ enum: DeliveryInstruction, enumName: 'DeliveryInstruction' })
  @IsEnum(
    DeliveryInstruction,
    withParams({ allowed: Object.values(DeliveryInstruction) }),
  )
  delivery: DeliveryInstruction;
}
