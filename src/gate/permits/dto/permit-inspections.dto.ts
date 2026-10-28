import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

export const INSPECTION_OUTCOMES = ['passed', 'failed'] as const;

/** The management's decision on a completion inspection (ADR 0063). */
export class DecidePermitInspectionDto {
  @ApiProperty({ enum: INSPECTION_OUTCOMES })
  @IsIn(
    [...INSPECTION_OUTCOMES],
    withParams({ allowed: [...INSPECTION_OUTCOMES] }),
  )
  outcome: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'A failure’s findings, REASON_CODES.worksFinding (one to five); none on a pass.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5, withParams({ max: 5 }))
  @IsString({ each: true })
  findings?: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: 5,
    description: 'Finalized `works_inspection_photo` files.',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @ArrayMaxSize(5, withParams({ max: 5 }))
  @IsUUID('all', { each: true })
  photoFileIds: string[];
}

export const PERMIT_INSPECTION_STATUSES = [
  'asked',
  'passed',
  'failed',
] as const;

export class PermitInspectionsQueryDto {
  @ApiPropertyOptional({
    enum: PERMIT_INSPECTION_STATUSES,
    description: 'Default: asked.',
  })
  @IsOptional()
  @IsIn(
    [...PERMIT_INSPECTION_STATUSES],
    withParams({ allowed: [...PERMIT_INSPECTION_STATUSES] }),
  )
  status?: string;
}

export class WorksCertificateCodeDto {
  @ApiProperty({
    type: String,
    description: 'The code printed on the certificate (22 characters).',
  })
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  code: string;
}
