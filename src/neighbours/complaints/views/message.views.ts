import { ApiProperty } from '@nestjs/swagger';
import {
  NeighbourSide,
  NeighbourThread,
  type NeighbourComplaintMessage,
} from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import type {
  AttachmentRead,
  MessageRead,
} from '../complaint-messages.service';

export class ComplaintMessageCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No body: the stored replay of a post holds no free text. */
  static from(
    m: Pick<NeighbourComplaintMessage, 'id' | 'createdAt'>,
  ): ComplaintMessageCreatedView {
    return { id: m.id, createdAt: m.createdAt };
  }
}

/** A photo or a document on a message. */
export class ComplaintAttachmentView {
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

  static from(a: AttachmentRead): ComplaintAttachmentView {
    return {
      id: a.id,
      contentType: a.contentType,
      url: a.read?.url ?? null,
      expiresAt: a.read?.expiresAt ?? null,
    };
  }
}

/**
 * A message as a resident reads it in their own thread: the complaint's
 * author in theirs, the unit complained about in its own. It has no field
 * for a thread: nothing here could say another one exists. Staff are named
 * by first name.
 */
export class ResidentComplaintMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: FirstNameRefView })
  sender: FirstNameRefView;
  @ApiProperty({ enum: NeighbourSide, enumName: 'NeighbourSide' })
  senderSide: NeighbourSide;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its sender was erased.',
  })
  body: string | null;
  @ApiProperty({ type: Boolean })
  erased: boolean;
  @ApiProperty({ type: [ComplaintAttachmentView] })
  attachments: ComplaintAttachmentView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MessageRead): ResidentComplaintMessageView {
    return {
      id: r.message.id,
      sender: firstNameRef(r.sender),
      senderSide: r.message.senderSide,
      body: r.message.body,
      erased: r.message.erasedAt !== null,
      attachments: r.attachments.map((a) => ComplaintAttachmentView.from(a)),
      createdAt: r.message.createdAt,
    };
  }
}

/** A message as staff read it: its thread, and its sender by full name. */
export class StaffComplaintMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: NeighbourThread,
    enumName: 'NeighbourThread',
    description:
      '`complainant`: the author reads it. `target`: the unit complained about reads it. `internal`: a staff note nobody else reads.',
  })
  thread: NeighbourThread;
  @ApiProperty({ type: AccountRefView })
  sender: AccountRefView;
  @ApiProperty({ enum: NeighbourSide, enumName: 'NeighbourSide' })
  senderSide: NeighbourSide;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its sender was erased.',
  })
  body: string | null;
  @ApiProperty({ type: Boolean })
  erased: boolean;
  @ApiProperty({ type: [ComplaintAttachmentView] })
  attachments: ComplaintAttachmentView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MessageRead): StaffComplaintMessageView {
    return {
      id: r.message.id,
      thread: r.message.thread,
      sender: accountRef(r.sender),
      senderSide: r.message.senderSide,
      body: r.message.body,
      erased: r.message.erasedAt !== null,
      attachments: r.attachments.map((a) => ComplaintAttachmentView.from(a)),
      createdAt: r.message.createdAt,
    };
  }
}
