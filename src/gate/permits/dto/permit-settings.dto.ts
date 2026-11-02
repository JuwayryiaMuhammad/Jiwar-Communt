import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { TIME_OF_DAY } from '../permit-rules';

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
    type: Boolean,
    required: false,
    description:
      'On (the default), a works permit is approved only once its finishing-works deposit holds money (ADR 0074).',
  })
  @IsOptional()
  @IsBoolean()
  worksDepositRequired?: boolean;
}
