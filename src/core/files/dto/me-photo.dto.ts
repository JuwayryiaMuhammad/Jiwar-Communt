import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** The caller sets or replaces their own photo (ADR 0031). */
export class MyPhotoDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: "A finalized `resident_photo` of the caller's.",
  })
  @IsUUID()
  fileId: string;
}
