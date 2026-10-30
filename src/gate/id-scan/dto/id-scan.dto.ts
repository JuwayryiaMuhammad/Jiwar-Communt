import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** A document the guard photographed, to read (ADR 0068). */
export class IdScanDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The guard’s finalized `gate_id_scan` file. Deleted once read, whatever came of it.',
  })
  @IsUUID()
  imageFileId: string;
}
