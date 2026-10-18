import { ApiProperty } from '@nestjs/swagger';
import { FacilityCapacityUnit, FacilityMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  END_MINUTE,
  START_MINUTE,
  WEEKDAY,
} from '../../../core/common/slots/weekly-windows';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  MAX_WINDOWS,
  POSITION,
  RULE_RANGES,
  type FacilityRuleName,
} from '../facility-rules';

export const FACILITY_NAME = { min: 1, max: 80 } as const;
export const FACILITY_DESCRIPTION = { min: 1, max: 1000 } as const;

/** One optional whole number inside its rule's range. */
function Rule(name: FacilityRuleName, description: string) {
  const { min, max } = RULE_RANGES[name];
  const params = withParams({ min, max });
  return (target: object, key: string) => {
    ApiProperty({
      type: Number,
      required: false,
      minimum: min,
      maximum: max,
      description,
    })(target, key);
    IsOptional()(target, key);
    IsInt(params)(target, key);
    Min(min, params)(target, key);
    Max(max, params)(target, key);
  };
}

function Name(required: boolean) {
  return (target: object, key: string) => {
    ApiProperty({
      type: String,
      required,
      minLength: FACILITY_NAME.min,
      maxLength: FACILITY_NAME.max,
      description:
        'Both languages are required; surrounding spaces are trimmed.',
    })(target, key);
    if (!required) IsOptional()(target, key);
    IsString()(target, key);
    Length(
      FACILITY_NAME.min,
      FACILITY_NAME.max,
      withParams(FACILITY_NAME),
    )(target, key);
  };
}

function Description() {
  return (target: object, key: string) => {
    ApiProperty({
      type: String,
      required: false,
      nullable: true,
      minLength: FACILITY_DESCRIPTION.min,
      maxLength: FACILITY_DESCRIPTION.max,
      description: 'Optional, per language. On an update, null clears it.',
    })(target, key);
    IsOptional()(target, key);
    ValidateIf((_, v) => v !== null)(target, key);
    IsString()(target, key);
    Length(
      FACILITY_DESCRIPTION.min,
      FACILITY_DESCRIPTION.max,
      withParams(FACILITY_DESCRIPTION),
    )(target, key);
  };
}

/** The rules a bookable facility takes; a walk-in facility takes none. */
class FacilityRulesInput {
  @Rule(
    'slotMinutes',
    'Length of a slot. Required to create a bookable facility.',
  )
  slotMinutes?: number;

  @Rule(
    'capacity',
    'What a slot takes, in `capacityUnit`. Required to create a bookable facility.',
  )
  capacity?: number;

  @ApiProperty({
    enum: FacilityCapacityUnit,
    enumName: 'FacilityCapacityUnit',
    required: false,
    description: 'Default `bookings`.',
  })
  @IsOptional()
  @IsEnum(FacilityCapacityUnit)
  capacityUnit?: FacilityCapacityUnit;

  @Rule(
    'maxDaysAhead',
    'How many local days ahead a slot may be booked. Default 14.',
  )
  maxDaysAhead?: number;

  @Rule(
    'minMinutesBefore',
    'A booking starts at least this many minutes from now. Default 60.',
  )
  minMinutesBefore?: number;

  @Rule(
    'cancelCutoffMinutes',
    'A resident cancels a confirmed booking at least this many minutes before it starts. Default 120.',
  )
  cancelCutoffMinutes?: number;

  @Rule('maxGuests', 'Guests a booking may bring beside its booker. Default 0.')
  maxGuests?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Default false.',
  })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Default false.',
  })
  @IsOptional()
  @IsBoolean()
  requiresMembership?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      "A booking may name one of the unit's children as its occasion (a birthday space, ADR 0054). Default false.",
  })
  @IsOptional()
  @IsBoolean()
  childOccasions?: boolean;

  @Rule(
    'weeklyQuota',
    'Bookings a unit may hold here in any 7 days. Default 2.',
  )
  weeklyQuota?: number;

  @Rule(
    'peakQuota',
    'Peak-time bookings a unit may hold here in any 7 days; at most `weeklyQuota`. Default 1.',
  )
  peakQuota?: number;
}

export class CreateFacilityDto extends FacilityRulesInput {
  @ApiProperty({
    enum: FacilityMode,
    enumName: 'FacilityMode',
    description:
      'Never changes. A walk-in facility takes no rule field (FIELD_NOT_ALLOWED).',
  })
  @IsEnum(FacilityMode)
  mode: FacilityMode;

  @Name(true)
  nameEn: string;

  @Name(true)
  nameAr: string;

  @Description()
  descriptionEn?: string | null;

  @Description()
  descriptionAr?: string | null;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: POSITION.min,
    maximum: POSITION.max,
    description: 'Order in the compound’s list. Default 0.',
  })
  @IsOptional()
  @IsInt(withParams(POSITION))
  @Min(POSITION.min, withParams(POSITION))
  @Max(POSITION.max, withParams(POSITION))
  position?: number;
}

export class UpdateFacilityDto extends FacilityRulesInput {
  @Name(false)
  nameEn?: string;

  @Name(false)
  nameAr?: string;

  @Description()
  descriptionEn?: string | null;

  @Description()
  descriptionAr?: string | null;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: POSITION.min,
    maximum: POSITION.max,
  })
  @IsOptional()
  @IsInt(withParams(POSITION))
  @Min(POSITION.min, withParams(POSITION))
  @Max(POSITION.max, withParams(POSITION))
  position?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'False retires the facility: no new booking, not listed to residents. Bookings already made stay.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class FacilityWindowDto {
  @ApiProperty({
    type: Number,
    minimum: WEEKDAY.min,
    maximum: WEEKDAY.max,
    description: '0 is Sunday.',
  })
  @IsInt(withParams({ ...WEEKDAY }))
  @Min(WEEKDAY.min, withParams({ ...WEEKDAY }))
  @Max(WEEKDAY.max, withParams({ ...WEEKDAY }))
  weekday: number;

  @ApiProperty({
    type: Number,
    minimum: START_MINUTE.min,
    maximum: START_MINUTE.max,
    description: 'Minutes after local midnight, in the compound’s time zone.',
  })
  @IsInt(withParams({ ...START_MINUTE }))
  @Min(START_MINUTE.min, withParams({ ...START_MINUTE }))
  @Max(START_MINUTE.max, withParams({ ...START_MINUTE }))
  startMinute: number;

  @ApiProperty({
    type: Number,
    minimum: END_MINUTE.min,
    maximum: END_MINUTE.max,
  })
  @IsInt(withParams({ ...END_MINUTE }))
  @Min(END_MINUTE.min, withParams({ ...END_MINUTE }))
  @Max(END_MINUTE.max, withParams({ ...END_MINUTE }))
  endMinute: number;
}

export class ReplaceFacilityWindowsDto {
  @ApiProperty({
    type: [FacilityWindowDto],
    maxItems: MAX_WINDOWS,
    description:
      'The whole week. Windows of one weekday may touch, never overlap (WINDOW_OVERLAP). An empty list: no hours (the facility offers no slot), or no peak times.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_WINDOWS, withParams({ min: 0, max: MAX_WINDOWS }))
  @ValidateNested({ each: true })
  @Type(() => FacilityWindowDto)
  windows: FacilityWindowDto[];
}
