import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { IsLocalDate } from '../../common/validation/local-date';
import { withParams } from '../../common/validation/validation-errors';

const NAME = withParams({ min: 1, max: 80 });

export class HolidaysQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'Today by default.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description:
      'At most 366 days from `from` (PERIOD_TOO_LONG); a year on by default.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}

export class CreateHolidayDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description:
      'A local day of the compound, at most a year back and two years ahead (DAY_OUT_OF_RANGE); one holiday a day (HOLIDAY_EXISTS).',
  })
  @IsString()
  @IsLocalDate()
  day: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80, NAME)
  nameEn: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80, NAME)
  nameAr: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'On (the default), works and moves stop that day: a day off of the permits (ADR 0049). Bookings and planned work are only flagged, either way.',
  })
  @IsOptional()
  @IsBoolean()
  stopsWorks?: boolean;
}

export class UpdateHolidayDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 80, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 80, NAME)
  nameEn?: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 80, NAME)
  nameAr?: string;

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  stopsWorks?: boolean;
}
