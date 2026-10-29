import { ApiProperty } from '@nestjs/swagger';
import { VehicleType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PLATE_MAX } from '../../../core/common/vehicle-plate';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import { VEHICLE_SETTING_RANGES, type VehicleSettingName } from '../defaults';
import {
  COLOR,
  MAKE_AND_MODEL,
  PERMIT_STATUSES,
  type PermitStatus,
} from '../vehicle-rules';

const PLATE_DOC =
  'Arabic letters, Latin letters, Western or Arabic-Indic digits and spaces; tidied (trimmed, single spaces, Latin upper case), at most 12 characters after that (INVALID_FORMAT, params.maxLength).';

export class CreateVehicleDto {
  @ApiProperty({
    type: String,
    maxLength: PLATE_MAX,
    example: 'ق ب ط ١٢٣٤',
    description: PLATE_DOC,
  })
  @IsString()
  plate: string;

  @ApiProperty({
    type: String,
    minLength: MAKE_AND_MODEL.min,
    maxLength: MAKE_AND_MODEL.max,
    example: 'Hyundai Elantra',
  })
  @IsString()
  makeAndModel: string;

  @ApiProperty({
    type: String,
    minLength: COLOR.min,
    maxLength: COLOR.max,
    example: 'Silver',
  })
  @IsString()
  color: string;

  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType' })
  @IsEnum(VehicleType, withParams({ allowed: Object.values(VehicleType) }))
  type: VehicleType;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A finalized `vehicle_licence` upload of the caller (FILE_NOT_AVAILABLE otherwise).',
  })
  @IsOptional()
  @IsUUID()
  licencePhotoFileId?: string;
}

export class UpdateVehicleDto {
  @ApiProperty({
    type: String,
    required: false,
    maxLength: PLATE_MAX,
    description: `${PLATE_DOC} A new plate sends the vehicle back to \`pending\` and voids its sticker; the same plate typed differently changes nothing.`,
  })
  @IsOptional()
  @IsString()
  plate?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: MAKE_AND_MODEL.min,
    maxLength: MAKE_AND_MODEL.max,
    description: 'Keeps the status.',
  })
  @IsOptional()
  @IsString()
  makeAndModel?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: COLOR.min,
    maxLength: COLOR.max,
    description: 'Keeps the status.',
  })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiProperty({
    enum: VehicleType,
    enumName: 'VehicleType',
    required: false,
    description: 'Keeps the status.',
  })
  @IsOptional()
  @IsEnum(VehicleType, withParams({ allowed: Object.values(VehicleType) }))
  type?: VehicleType;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'A new `vehicle_licence` upload replaces the photo; `null` removes it. Keeps the status.',
  })
  @IsOptional()
  @IsUUID()
  licencePhotoFileId?: string | null;
}

export class RemoveVehicleQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    default: 'other',
    description: 'From the closed list `vehicleRemove`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class StaffVehiclesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: [...PERMIT_STATUSES],
    enumName: 'VehiclePermitStatus',
    required: false,
    description:
      '`pending` lists the oldest first; anything else the newest first.',
  })
  @IsOptional()
  @IsIn([...PERMIT_STATUSES], withParams({ allowed: [...PERMIT_STATUSES] }))
  status?: PermitStatus;

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'Matched by the plate’s key: spaces and the digits’ script do not matter.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 40, withParams({ min: 1, max: 40 }))
  plate?: string;
}

class VersionedDto {
  @ApiProperty({
    type: Number,
    description: 'The `version` the staff read (VEHICLE_CHANGED otherwise).',
  })
  @Type(() => Number)
  @IsInt(withParams({ min: 1 }))
  @Min(1, withParams({ min: 1 }))
  version: number;
}

export class ApproveVehicleDto extends VersionedDto {
  @ApiProperty({
    type: String,
    pattern: '^[A-Za-z0-9-]{1,20}$',
    description:
      'Upper-cased. Issued once in the compound, ever (DUPLICATE_RESOURCE on stickerNumber).',
  })
  @IsString()
  stickerNumber: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The permit’s last local day: after today, at most 731 days ahead (PERMIT_DATE_OUT_OF_RANGE).',
  })
  @IsString()
  @IsLocalDate()
  permitValidUntil: string;
}

export class RejectVehicleDto extends VersionedDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `vehicleReject`.',
  })
  @IsString()
  reasonCode: string;
}

export class RenewVehicleDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The new last local day: after today, not before the current one, at most 731 days ahead.',
  })
  @IsString()
  @IsLocalDate()
  permitValidUntil: string;
}

export class StaffRemoveVehicleDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `vehicleStaffRemove`.',
  })
  @IsString()
  reasonCode: string;
}

/** One optional whole number inside its column's range. */
function Setting(name: VehicleSettingName, description: string) {
  const { min, max } = VEHICLE_SETTING_RANGES[name];
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

export class UpdateVehicleSettingsDto {
  @Setting('maxVehiclesPerUnit', 'Pending or active vehicles per unit.')
  maxVehiclesPerUnit?: number;

  @Setting(
    'visitorParkingMaxHours',
    'The longest visitor parking booking, in hours.',
  )
  visitorParkingMaxHours?: number;

  @Setting(
    'maxActiveVisitorParkingBookings',
    'Visitor parking bookings a unit holds at once (not yet ended).',
  )
  maxActiveVisitorParkingBookings?: number;
}
