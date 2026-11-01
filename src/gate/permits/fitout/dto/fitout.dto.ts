import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** A drawing joined to a works permit (ADR 0074). */
export class AddPermitDrawingDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A finalized `permit_drawing` file of the caller’s.',
  })
  @IsUUID()
  fileId: string;
}
