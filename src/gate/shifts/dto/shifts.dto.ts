import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class StartShiftDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  gateId: string;
}
