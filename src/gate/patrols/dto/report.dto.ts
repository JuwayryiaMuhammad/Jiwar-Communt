import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';

export class PatrolReportQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-11-01',
    description:
      'The compound’s first day: six days ago by default. A week by default, 31 days at most (PERIOD_TOO_LONG).',
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
}
