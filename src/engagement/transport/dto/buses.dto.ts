import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { BUS_NAME_LENGTH, STOP_LENGTH } from '../buses.service';

/** A local time of day, `HH:MM`. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateBusRouteDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @IsString()
  @Length(
    BUS_NAME_LENGTH.min,
    BUS_NAME_LENGTH.max,
    withParams({ ...BUS_NAME_LENGTH }),
  )
  nameEn: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @IsString()
  @Length(
    BUS_NAME_LENGTH.min,
    BUS_NAME_LENGTH.max,
    withParams({ ...BUS_NAME_LENGTH }),
  )
  nameAr: string;
}

export class UpdateBusRouteDto {
  @ApiProperty({ type: String, required: false, minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(
    BUS_NAME_LENGTH.min,
    BUS_NAME_LENGTH.max,
    withParams({ ...BUS_NAME_LENGTH }),
  )
  nameEn?: string;

  @ApiProperty({ type: String, required: false, minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(
    BUS_NAME_LENGTH.min,
    BUS_NAME_LENGTH.max,
    withParams({ ...BUS_NAME_LENGTH }),
  )
  nameAr?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False retires it.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AddBusDepartureDto {
  @ApiProperty({
    type: [Number],
    description: 'Weekdays it runs: 0 is Sunday, 6 Saturday.',
    example: [0, 1, 2, 3, 4],
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: 7 }))
  @ArrayMaxSize(7, withParams({ min: 1, max: 7 }))
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays: number[];

  @ApiProperty({
    type: String,
    example: '07:30',
    description: 'The compound’s local time of day, `HH:MM`.',
  })
  @IsString()
  @Matches(TIME)
  time: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @IsString()
  @Length(STOP_LENGTH.min, STOP_LENGTH.max, withParams({ ...STOP_LENGTH }))
  fromStop: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 80 })
  @IsString()
  @Length(STOP_LENGTH.min, STOP_LENGTH.max, withParams({ ...STOP_LENGTH }))
  toStop: string;
}
