import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  HAZARDS,
  INSTRUCTION_MAX,
  PRECAUTIONS_MAX,
  WORK_PERMIT_STATUSES,
  type Hazard,
  type WorkPermitStatus,
} from '../safety-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const PRECAUTIONS = { min: 1, max: PRECAUTIONS_MAX };
const INSTRUCTION = { min: 1, max: INSTRUCTION_MAX };

export class RequestPermitDto {
  @ApiProperty({ enum: HAZARDS, enumName: 'WorkHazard' })
  @IsIn(HAZARDS, allowed(HAZARDS))
  hazard: Hazard;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: PRECAUTIONS_MAX,
    description:
      'What the technician will do to work safely. Their words: never in a notice.',
  })
  @IsString()
  @Length(PRECAUTIONS.min, PRECAUTIONS.max, withParams(PRECAUTIONS))
  precautions: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'With its offset; after now and within 24 hours.',
  })
  @ToInstant()
  @IsDate()
  expiresAt: Date;
}

export class PermitsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: WORK_PERMIT_STATUSES,
    enumName: 'WorkPermitStatus',
  })
  @IsOptional()
  @IsIn(WORK_PERMIT_STATUSES, allowed(WORK_PERMIT_STATUSES))
  status?: WorkPermitStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ticketId?: string;
}

export class HazardsDto {
  @ApiProperty({
    enum: HAZARDS,
    enumName: 'WorkHazard',
    isArray: true,
    description: 'The whole list; empty: no permit needed.',
  })
  @IsArray()
  @ArrayMaxSize(HAZARDS.length, withParams({ max: HAZARDS.length }))
  @IsIn(HAZARDS, { each: true, ...allowed(HAZARDS) })
  hazards: Hazard[];
}

export class PublishInstructionDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: INSTRUCTION_MAX })
  @IsString()
  @Length(INSTRUCTION.min, INSTRUCTION.max, withParams(INSTRUCTION))
  textEn: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: INSTRUCTION_MAX })
  @IsString()
  @Length(INSTRUCTION.min, INSTRUCTION.max, withParams(INSTRUCTION))
  textAr: string;
}

export class AcknowledgeDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The current version’s id, as the technician was shown it.',
  })
  @IsUUID()
  instructionId: string;
}
