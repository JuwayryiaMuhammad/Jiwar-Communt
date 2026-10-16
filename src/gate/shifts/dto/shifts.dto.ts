import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/** A gate or a zone (one of the compound's places), exactly one (ADR 0050). */
export class StartShiftDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'A place in service (`GET /community/places`), for a shift that is not at a gate.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}
