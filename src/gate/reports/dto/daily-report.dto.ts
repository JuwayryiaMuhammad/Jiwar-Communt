import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';

export class DailyReportQueryDto {
  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'A day of the compound, `YYYY-MM-DD`. Default today.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  date?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'One gate only.',
  })
  @IsOptional()
  @IsUUID()
  gateId?: string;
}
