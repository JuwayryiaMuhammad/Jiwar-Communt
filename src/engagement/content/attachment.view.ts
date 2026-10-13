import { ApiProperty } from '@nestjs/swagger';
import type { AttachmentRead } from './attachments';

/** A photo or a document the staff attached. */
export class CommunityAttachmentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description: 'image/jpeg, image/png, image/webp or application/pdf.',
  })
  contentType: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned GET, valid until `expiresAt`. Null when gone.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;

  static from(a: AttachmentRead): CommunityAttachmentView {
    return {
      id: a.id,
      contentType: a.contentType,
      url: a.read?.url ?? null,
      expiresAt: a.read?.expiresAt ?? null,
    };
  }
}
