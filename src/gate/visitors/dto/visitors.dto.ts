import { ApiProperty } from '@nestjs/swagger';
import {
  DeliveryInstruction,
  StandingInstructionAction,
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
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { DESCRIPTION_LENGTH } from '../standing-instructions.service';
import { PLATE_MAX } from '../../../core/common/vehicle-plate';

const PARTY = { min: 1, max: 50 };
/** A visit's expected minutes (ADR 0056): within the unconfirmed exit's 12 hours. */
const VISIT_MINUTES = { min: 15, max: 720 };

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

  @ApiProperty({
    type: Number,
    minimum: PARTY.min,
    maximum: PARTY.max,
    description:
      'How many people the code lets in (ADR 0043). One-time: one per entry, at any gate, until all came in or `validUntil`. Recurring: how many may be inside at once, on every visit.',
  })
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

  @ApiProperty({
    type: String,
    required: false,
    maxLength: PLATE_MAX,
    example: 'ق ب ط ١٢٣٤',
    description:
      'The visitor’s car (ADR 0043): Arabic or Latin letters, Western or Arabic-Indic digits and spaces, at most 12 after tidying (trimmed, spaces collapsed, Latin upper-cased). Otherwise INVALID_FORMAT with `maxLength`. Shown to the host and to the guard who checks the code; deleted with the name.',
  })
  @IsOptional()
  @IsString()
  vehiclePlate?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: VISIT_MINUTES.min,
    maximum: VISIT_MINUTES.max,
    description:
      'How long a visit on it is expected to last, in minutes (ADR 0056). A visitor still inside past it alerts the guards on shift and the host, once; nothing else. Without it, the compound’s setting applies.',
  })
  @IsOptional()
  @IsInt(withParams(VISIT_MINUTES))
  @Min(VISIT_MINUTES.min, withParams(VISIT_MINUTES))
  @Max(VISIT_MINUTES.max, withParams(VISIT_MINUTES))
  expectedMinutes?: number;
}

export class CancelVisitorPassDto {
  @ApiProperty({
    enum: REASON_CODES.visitorPassCancel,
    enumName: 'VisitorPassCancelReason',
    description:
      'Required. The closed list `visitorPassCancel`: `not_needed` (the visit is off), `plans_changed` (another day or other visitors), `other`. Missing: REASON_REQUIRED; outside the list: INVALID_REASON_CODE with `allowed`.',
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

/** The values, each said once for every view (ADR 0043). */
export const STANDING_ACTION_DOC = [
  '- `always_allow`: the guard lets them in and logs the entry.',
  '- `never_allow`: the guard turns them away.',
  '- `call_first`: the guard asks the household (the gate request) before letting them in.',
  '- `leave_at_gate`: what they bring is left at the gate; they do not come in.',
].join('\n');

export class CreateStandingInstructionDto {
  @ApiProperty({
    type: String,
    minLength: DESCRIPTION_LENGTH.min,
    maxLength: DESCRIPTION_LENGTH.max,
    example: 'My mother, Hoda, grey Toyota',
    description:
      'Who it is about, in a few words (spaces tidied). Personal: shown to the household and to the guard, never in a notification or the audit trail; deleted with its author.',
  })
  @IsString()
  @Length(
    DESCRIPTION_LENGTH.min,
    DESCRIPTION_LENGTH.max,
    withParams({ ...DESCRIPTION_LENGTH }),
  )
  description: string;

  @ApiProperty({
    enum: StandingInstructionAction,
    enumName: 'StandingInstructionAction',
    description: STANDING_ACTION_DOC,
  })
  @IsEnum(
    StandingInstructionAction,
    withParams({ allowed: Object.values(StandingInstructionAction) }),
  )
  action: StandingInstructionAction;
}
