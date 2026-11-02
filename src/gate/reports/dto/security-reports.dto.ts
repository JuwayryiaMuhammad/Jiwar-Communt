import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';

/** The incidents and violations reports' period (ADR 0053). */
export class SecurityReportQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-11-01',
    description:
      'The compound’s first day: six days ago by default. A week by default; 366 days at most for incidents (ADR 0087), 31 for violations (PERIOD_TOO_LONG).',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-07' })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}

/** The safety KPIs' period (ADR 0087): up to a year. */
export class SafetyReportQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-10-01',
    description:
      'The compound’s first day: 29 days ago by default. 30 days by default, 366 at most (PERIOD_TOO_LONG).',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiPropertyOptional({ type: String, example: '2026-10-30' })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}
