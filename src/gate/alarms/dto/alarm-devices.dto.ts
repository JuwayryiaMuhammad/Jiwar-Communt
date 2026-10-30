import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const REF = { min: 1, max: 120 } as const;
const LABEL = { min: 1, max: 60 } as const;
const STATUSES = ['active', 'retired', 'all'] as const;

/** A vendor's wearable the management registers (ADR 0068). */
export class RegisterAlarmDeviceDto {
  @ApiProperty({
    type: String,
    minLength: REF.min,
    maxLength: REF.max,
    description: 'The vendor’s own id of the device. One live device each.',
  })
  @IsString()
  @Length(REF.min, REF.max, withParams(REF))
  deviceRef: string;

  @ApiProperty({ type: String, minLength: LABEL.min, maxLength: LABEL.max })
  @IsString()
  @Length(LABEL.min, LABEL.max, withParams(LABEL))
  label: string;
}

export class RenameAlarmDeviceDto {
  @ApiProperty({ type: String, minLength: LABEL.min, maxLength: LABEL.max })
  @IsString()
  @Length(LABEL.min, LABEL.max, withParams(LABEL))
  label: string;
}

export class RetireAlarmDeviceDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `alarmDeviceRetire`.',
  })
  @IsString()
  reasonCode: string;
}

export class AlarmDeviceQueryDto {
  @ApiProperty({ enum: STATUSES, required: false })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];
}

/** The device a guard on shift wears (ADR 0068). */
export class PairAlarmDeviceDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  deviceId: string;
}
