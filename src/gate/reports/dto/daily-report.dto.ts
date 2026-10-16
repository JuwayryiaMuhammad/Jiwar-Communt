import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';

export class DailyReportQueryDto {
  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'A day of the compound, `YYYY-MM-DD`. Default today.',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
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
