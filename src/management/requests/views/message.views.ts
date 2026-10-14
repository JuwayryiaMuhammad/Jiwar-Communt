import { ApiProperty } from '@nestjs/swagger';
import { ManagementSide, type ManagementRequestMessage } from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import type { AttachmentRead, MessageRead } from '../messages.service';

export class RequestMessageCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No body: the stored replay of a post holds no free text. */
  static from(
    m: Pick<ManagementRequestMessage, 'id' | 'createdAt'>,
  ): RequestMessageCreatedView {
    return { id: m.id, createdAt: m.createdAt };
  }
}

/** A photo or a document on a message. */
export class MessageAttachmentView {
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

  static from(a: AttachmentRead): MessageAttachmentView {
    return {
      id: a.id,
      contentType: a.contentType,
      url: a.read?.url ?? null,
      expiresAt: a.read?.expiresAt ?? null,
    };
  }
}

/**
 * A message as the request's author reads it: never a staff note, and so
 * no field that could say one exists. Staff are named by first name.
 */
export class ResidentRequestMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: FirstNameRefView })
  sender: FirstNameRefView;
  @ApiProperty({ enum: ManagementSide, enumName: 'ManagementSide' })
  senderSide: ManagementSide;
  @ApiProperty({
    type: Boolean,
    description: 'The management’s official reply to the request.',
  })
  official: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its sender was erased.',
  })
  body: string | null;
  @ApiProperty({ type: Boolean })
  erased: boolean;
  @ApiProperty({ type: [MessageAttachmentView] })
  attachments: MessageAttachmentView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MessageRead): ResidentRequestMessageView {
    return {
      id: r.message.id,
      sender: firstNameRef(r.sender),
      senderSide: r.message.senderSide,
      official: r.message.official,
      body: r.message.body,
      erased: r.message.erasedAt !== null,
      attachments: r.attachments.map((a) => MessageAttachmentView.from(a)),
      createdAt: r.message.createdAt,
    };
  }
}

/** A message as staff read it: notes too, senders by full name. */
export class StaffRequestMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  sender: AccountRefView;
  @ApiProperty({ enum: ManagementSide, enumName: 'ManagementSide' })
  senderSide: ManagementSide;
  @ApiProperty({
    type: Boolean,
    description: 'A staff note: the author never sees it.',
  })
  internal: boolean;
  @ApiProperty({ type: Boolean })
  official: boolean;
  @ApiProperty({
    type: Number,
    description: 'The request’s cycle when it was written.',
  })
  cycle: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its sender was erased.',
  })
  body: string | null;
  @ApiProperty({ type: Boolean })
  erased: boolean;
  @ApiProperty({ type: [MessageAttachmentView] })
  attachments: MessageAttachmentView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MessageRead): StaffRequestMessageView {
    return {
      id: r.message.id,
      sender: accountRef(r.sender),
      senderSide: r.message.senderSide,
      internal: r.message.internal,
      official: r.message.official,
      cycle: r.message.cycle,
      body: r.message.body,
      erased: r.message.erasedAt !== null,
      attachments: r.attachments.map((a) => MessageAttachmentView.from(a)),
      createdAt: r.message.createdAt,
    };
  }
}
