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
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import {
  INSTRUCTION_STATES,
  type InstructionState,
} from '../instruction-validity';

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

  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2026-12-20',
    description:
      'The compound day it holds from, inclusive (ADR 0056). Until then guards neither see it nor are told of it; they are told at their first shift start on a day it holds. Default: from now.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  validFrom?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2027-01-05',
    description:
      'The last compound day it holds, inclusive: not before `validFrom` (ENDS_BEFORE_START), nor before today (DAY_OUT_OF_RANGE {min}). After it, guards no longer see it. Default: until archived. Both are fixed once sent.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  validUntil?: string;
}

export class StaffGuardInstructionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: INSTRUCTION_STATES,
    enumName: 'GuardInstructionState',
    description:
      'Today, in the compound’s calendar (ADR 0056): `scheduled` (not yet valid), `live` (valid; guards see it), `expired` (past its last day), `archived`. Default: all.',
  })
  @IsOptional()
  @IsIn(INSTRUCTION_STATES)
  state?: InstructionState;
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
