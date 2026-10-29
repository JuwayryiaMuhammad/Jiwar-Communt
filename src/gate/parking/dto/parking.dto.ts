import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  AREA_CAPACITY,
  AREA_NAME,
  SLOT_CODE,
  SLOT_PLACE,
  VISITOR_NAME,
} from '../parking-rules';
import { IsInstant } from '../../../core/common/validation/instant';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';

export class CreateVisitorParkingDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active visitor area (AREA_NOT_AVAILABLE).',
  })
  @IsUUID()
  areaId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      'An active pass of the unit the caller manages (PASS_NOT_AVAILABLE); the window lies inside its validity (PARKING_OUTSIDE_PASS). Null or absent: give `visitorName`.',
  })
  @IsOptional()
  @IsUUID()
  visitorPassId?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    minLength: VISITOR_NAME.min,
    maxLength: VISITOR_NAME.max,
    description:
      'Without a pass only (FIELD_NOT_ALLOWED with one). Deleted 30 days after the booking ends.',
  })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  visitorName?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Whole minutes; no earlier than 15 minutes ago, at most 14 days ahead.',
  })
  @IsInstant()
  startsAt: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Whole minutes; 15 minutes to the compound’s `visitorParkingMaxHours` after the start.',
  })
  @IsInstant()
  endsAt: string;
}

export class VisitorParkingQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ['upcoming', 'past'],
    required: false,
    default: 'upcoming',
    description:
      'Upcoming: confirmed and not ended, soonest first. Past: ended or cancelled, latest first.',
  })
  @IsOptional()
  @IsIn(['upcoming', 'past'], withParams({ allowed: ['upcoming', 'past'] }))
  status?: 'upcoming' | 'past';
}

export class ParkingSlotsQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;
}

export class CreateParkingSlotDto {
  @ApiProperty({
    type: String,
    description: 'The unit’s code (UNIT_CODE_UNKNOWN).',
  })
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode: string;

  @ApiProperty({
    type: String,
    minLength: SLOT_CODE.min,
    maxLength: SLOT_CODE.max,
    description:
      'Upper-cased; once in the compound (DUPLICATE_RESOURCE on code).',
  })
  @IsString()
  code: string;

  @ApiProperty({
    type: String,
    minLength: SLOT_PLACE.min,
    maxLength: SLOT_PLACE.max,
  })
  @IsString()
  place: string;
}

export class UpdateParkingSlotDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: SLOT_CODE.min,
    maxLength: SLOT_CODE.max,
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: SLOT_PLACE.min,
    maxLength: SLOT_PLACE.max,
  })
  @IsOptional()
  @IsString()
  place?: string;
}

export class CreateVisitorAreaDto {
  @ApiProperty({
    type: String,
    minLength: AREA_NAME.min,
    maxLength: AREA_NAME.max,
    description: 'Once in the compound.',
  })
  @IsString()
  name: string;

  @ApiProperty({
    type: Number,
    minimum: AREA_CAPACITY.min,
    maximum: AREA_CAPACITY.max,
  })
  @IsInt(withParams(AREA_CAPACITY))
  @Min(AREA_CAPACITY.min, withParams(AREA_CAPACITY))
  @Max(AREA_CAPACITY.max, withParams(AREA_CAPACITY))
  capacity: number;
}

export class UpdateVisitorAreaDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: AREA_NAME.min,
    maxLength: AREA_NAME.max,
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: AREA_CAPACITY.min,
    maximum: AREA_CAPACITY.max,
    description: 'A smaller capacity leaves what is booked.',
  })
  @IsOptional()
  @IsInt(withParams(AREA_CAPACITY))
  @Min(AREA_CAPACITY.min, withParams(AREA_CAPACITY))
  @Max(AREA_CAPACITY.max, withParams(AREA_CAPACITY))
  capacity?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'False retires the area: no new booking, the booked ones stay.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class StaffVisitorParkingQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: LOCAL_DATE.source,
    description: 'A local day of the compound, `YYYY-MM-DD`. Default today.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  day?: string;
}

export class StaffCancelVisitorParkingDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `visitorParkingStaffCancel`.',
  })
  @IsString()
  reasonCode: string;
}
