import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

const AUDIENCES = ['all', 'gate', 'zone'] as const;

export class SendGuardInstructionDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  title: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 4000 })
  @IsString()
  @Length(1, 4000, withParams({ min: 1, max: 4000 }))
  body: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description: 'A critical push (`guard_instruction.urgent`).',
  })
  @IsOptional()
  @IsBoolean()
  urgent?: boolean;

  @ApiProperty({ enum: AUDIENCES, enumName: 'GuardInstructionAudience' })
  @IsIn(AUDIENCES)
  audience: (typeof AUDIENCES)[number];

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'For `gate`: a gate in service.',
  })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'For `zone`: a place in service.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}

export class StaffGuardInstructionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['live', 'archived'] })
  @IsOptional()
  @IsIn(['live', 'archived'])
  state?: 'live' | 'archived';
}

export class MyGuardInstructionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['pending', 'acknowledged'],
    description: '`pending`: those waiting for me. Default: all.',
  })
  @IsOptional()
  @IsIn(['pending', 'acknowledged'])
  status?: 'pending' | 'acknowledged';

  @ApiPropertyOptional({
    type: String,
    maxLength: 100,
    description: 'Words of the title or the text (the archive).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  q?: string;
}
