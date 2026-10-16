import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';

const STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
  'incomplete',
  'timed_out',
  'missed',
  'cancelled',
] as const;

export class RunsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-11-01',
    description:
      'The compound’s first day; six days ago by default. A week by default, 31 days at most (PERIOD_TOO_LONG).',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  from?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-07' })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  to?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  routeId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  guardId?: string;
}

export class CancelRunDto {
  @ApiPropertyOptional({
    enum: [...REASON_CODES.patrolRunCancel],
    description: 'Required (REASON_REQUIRED).',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
