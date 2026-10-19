import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { PLATE_MAX } from '../../../core/common/vehicle-plate';
import { withParams } from '../../../core/common/validation/validation-errors';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';
import {
  COMPANY_MAX,
  SERVICE_VEHICLE_KINDS,
  type ServiceVehicleKind,
} from '../service-vehicle-rules';

export class EnterServiceVehicleDto {
  @ApiProperty({
    type: String,
    example: 'ن ق ل 4521',
    description: `As every plate (ADR 0045): letters, digits and spaces, at most ${PLATE_MAX} after tidying (INVALID_FORMAT). Matched against the blocklist.`,
  })
  @IsString()
  plate: string;

  @ApiProperty({
    enum: SERVICE_VEHICLE_KINDS,
    enumName: 'ServiceVehicleKind',
  })
  @IsIn(
    SERVICE_VEHICLE_KINDS,
    withParams({ allowed: [...SERVICE_VEHICLE_KINDS] }),
  )
  kind: ServiceVehicleKind;

  @ApiProperty({ type: String, minLength: 1, maxLength: COMPANY_MAX })
  @IsString()
  @Length(1, COMPANY_MAX, withParams({ min: 1, max: COMPANY_MAX }))
  company: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'The unit served, if one; never with `facilityId`.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The facility served, if one; never with `unitCode`.',
  })
  @IsOptional()
  @IsUUID()
  facilityId?: string;
}

export class ServiceVehicleLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-11-04',
    description:
      'The compound’s first day: today by default; 31 days at most (PERIOD_TOO_LONG).',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  from?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-04' })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  to?: string;
}
