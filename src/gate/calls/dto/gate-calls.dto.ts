import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

/** A call from the gate to a unit's household (ADR 0068). */
export class StartGateCallDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: String,
    description: 'From the closed list `gateCallReason`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The gate request for this unit the call is about.',
  })
  @IsOptional()
  @IsUUID()
  approvalRequestId?: string;
}
