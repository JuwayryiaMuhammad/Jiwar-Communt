import { ApiProperty } from '@nestjs/swagger';
import { EmergencyType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

export class ReportEmergencyDto {
  @ApiProperty({ enum: EmergencyType, enumName: 'EmergencyType' })
  @IsEnum(EmergencyType, withParams({ allowed: Object.values(EmergencyType) }))
  type: EmergencyType;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A unit that gives the caller the emergency button.',
  })
  @IsUUID()
  unitId: string;
}

export class CancelEmergencyDto {
  @ApiProperty({
    type: String,
    required: false,
    description: 'From the closed list `emergencyCancel`; optional.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

const STATES = ['open', 'closed'] as const;

export class MyEmergenciesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: STATES,
    required: false,
    description:
      '`open`: reported, on the way or arrived; `closed`: resolved or cancelled.',
  })
  @IsOptional()
  @IsIn(STATES, withParams({ allowed: [...STATES] }))
  status?: (typeof STATES)[number];
}
