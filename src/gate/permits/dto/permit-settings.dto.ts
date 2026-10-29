import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { PERMIT_LIMITS, TIME_OF_DAY } from '../permit-rules';

/** A time window of one day, in the compound's time zone. */
export class PermitHoursDto {
  @ApiProperty({
    type: String,
    pattern: TIME_OF_DAY.source,
    example: '09:00',
    description: "`HH:mm`, a time of day in the compound's time zone.",
  })
  @IsString()
  @Matches(TIME_OF_DAY)
  from: string;

  @ApiProperty({
    type: String,
    pattern: TIME_OF_DAY.source,
    example: '17:00',
    description: '`HH:mm`, after `from` (ENDS_BEFORE_START): never overnight.',
  })
  @IsString()
  @Matches(TIME_OF_DAY)
  to: string;
}

export class UpdatePermitSettingsDto {
  @ApiProperty({
    type: [Number],
    required: false,
    example: [0, 1, 2, 3, 4, 6],
    description:
      'The week days works and moves may take place on: 0 = Sunday … 6 = Saturday, at least one.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: 7 }))
  @ArrayMaxSize(7, withParams({ min: 1, max: 7 }))
  @IsInt({ each: true, ...withParams({ min: 0, max: 6 }) })
  @Min(0, { each: true, ...withParams({ min: 0, max: 6 }) })
  @Max(6, { each: true, ...withParams({ min: 0, max: 6 }) })
  workDays?: number[];

  @ApiProperty({ type: PermitHoursDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => PermitHoursDto)
  workHours?: PermitHoursDto;

  @ApiProperty({
    type: [String],
    required: false,
    example: ['2026-12-25'],
    description: `Dated local days with no works and no moves (feasts), at most ${PERMIT_LIMITS.daysOff}. Replaces the list.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    PERMIT_LIMITS.daysOff,
    withParams({ min: 0, max: PERMIT_LIMITS.daysOff }),
  )
  @IsString({ each: true })
  @IsLocalDate({ each: true })
  daysOff?: string[];
}
