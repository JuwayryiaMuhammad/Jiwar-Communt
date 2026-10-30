import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';

/**
 * A report's days, as the economics reports take theirs (ADR 0065); kept
 * here, since facilities reads no other domain but community (ADR 0044).
 */
export class UsageQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'The first day, the compound’s; 29 days before `to` when left out.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'The last day, included; today when left out. A year and a day at most.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}
