import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';

const BOOLEAN = ['true', 'false'] as const;

export class NewBanDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active account that books: a resident or a family member.',
  })
  @IsUUID()
  accountId: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'One facility; left out, every facility.',
  })
  @IsOptional()
  @IsUUID()
  facilityId?: string;

  @ApiProperty({
    type: String,
    description: 'From the closed list `facilityBan`.',
  })
  @IsString()
  reasonCode: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'The compound’s last day it holds, inclusive, from today and within a year; left out, until lifted.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  endsOn?: string;
}

export class BansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  facilityId?: string;

  @ApiPropertyOptional({
    enum: BOOLEAN,
    description: '`true`: only those in force; `false`: only those over.',
  })
  @IsOptional()
  @IsIn(BOOLEAN, withParams({ allowed: [...BOOLEAN] }))
  inForce?: 'true' | 'false';
}

export class LiftBanDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `facilityBanLift`.',
  })
  @IsString()
  reasonCode: string;
}
