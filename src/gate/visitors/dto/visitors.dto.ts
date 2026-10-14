import { ApiProperty } from '@nestjs/swagger';
import {
  DeliveryInstruction,
  VisitorInstruction,
  VisitorPassKind,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';

const PARTY = { min: 1, max: 50 };

/** A time of day in the compound's time zone (ADR 0028), like a worker's. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class VisitorWindowDto {
  @ApiProperty({
    type: String,
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    example: '18:00',
    description: "`HH:mm`, a time of day in the compound's time zone.",
  })
  @IsString()
  @Matches(TIME)
  from: string;

  @ApiProperty({
    type: String,
    pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
    example: '23:00',
    description:
      '`HH:mm`. Before `from`: an overnight window (22:00–02:00 ends the next morning). Never equal to `from`.',
  })
  @IsString()
  @Matches(TIME)
  to: string;
}

export class VisitorScheduleDto {
  @ApiProperty({
    type: [Number],
    example: [2, 4],
    description:
      'Days of the week the windows apply: 0 (Sunday) … 6. Checked by the service (`INVALID_VALUE` with `min`, `max`).',
  })
  @IsArray()
  days: number[];

  @ApiProperty({ type: [VisitorWindowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VisitorWindowDto)
  windows: VisitorWindowDto[];
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
    type: VisitorScheduleDto,
    required: false,
    description:
      'Recurring passes only: the days of the week and the times of day (compound time zone) the code opens the gate, between `validFrom` and `validUntil`.',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => VisitorScheduleDto)
  schedule?: VisitorScheduleDto;

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
