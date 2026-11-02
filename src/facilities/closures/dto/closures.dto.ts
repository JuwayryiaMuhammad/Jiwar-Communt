import { ApiProperty } from '@nestjs/swagger';
import { IsDate, IsOptional, IsString, Matches } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ToInstant } from '../../../core/common/validation/instant';

export class CreateClosureDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'After the start (ENDS_BEFORE_START), at most 366 days after it (CLOSURE_TOO_LONG), and not already past (CLOSURE_ENDED).',
  })
  @ToInstant()
  @IsDate()
  endsAt: Date;

  @ApiProperty({
    type: String,
    description: 'From the closed list `facilityClosure`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: '^[0-9a-f]{64}$',
    description:
      'The token of `GET …/closure-preview` for the same window (ADR 0084). Needed when the closure cancels a booking with a fee (FACILITY_CLOSURE_PREVIEW_REQUIRED); with it, the closure applies exactly what was previewed or refuses (FACILITY_CLOSURE_PREVIEW_STALE).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  previewToken?: string;
}

export class ClosurePreviewQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'After the start (ENDS_BEFORE_START), at most 366 days after it (CLOSURE_TOO_LONG).',
  })
  @ToInstant()
  @IsDate()
  endsAt: Date;
}

export class LiftClosureDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `facilityClosureLift`.',
  })
  @IsString()
  reasonCode: string;
}

export class ClosuresQueryDto extends PageQueryDto {}
