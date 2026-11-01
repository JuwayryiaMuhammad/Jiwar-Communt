import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
} from 'class-validator';
import { IsInstant } from '../../common/validation/instant';
import { withParams } from '../../common/validation/validation-errors';

const PERMISSIONS = { min: 1, max: 50 } as const;

export class AppointDeputyDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active staff or manager account, not the caller.',
  })
  @IsUUID()
  deputyAccountId: string;

  @ApiProperty({
    type: [String],
    minItems: PERMISSIONS.min,
    maxItems: PERMISSIONS.max,
    description:
      'Out of the caller’s own role, the deputy’s kind allowed; never finance.*, governance.*, appeals.decide, roles.manage or deputies.manage (INVALID_VALUE with params.permission).',
  })
  @IsArray()
  @ArrayMinSize(PERMISSIONS.min, withParams(PERMISSIONS))
  @ArrayMaxSize(PERMISSIONS.max, withParams(PERMISSIONS))
  @IsString({ each: true })
  permissions: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When it ends: after now and at most 30 days ahead (INVALID_VALUE, params.maxDays). It starts now.',
  })
  @IsInstant()
  endsAt: string;
}
