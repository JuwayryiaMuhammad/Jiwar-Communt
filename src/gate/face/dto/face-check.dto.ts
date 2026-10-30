import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** A face to check against the blocklist's (ADR 0068). */
export class FaceCheckDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The guard’s finalized `gate_face_probe` file: the photo of the face at the gate.',
  })
  @IsUUID()
  photoFileId: string;
}
