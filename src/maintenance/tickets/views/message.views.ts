import { ApiProperty } from '@nestjs/swagger';
import type { TicketMessage } from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import type { MessageRead, Sender } from '../messages.service';

const SENDER_KINDS = ['resident', 'staff', 'manager'] as const;
type SenderKind = (typeof SENDER_KINDS)[number];

function kindOf(sender: Sender): SenderKind {
  return sender.type === 'manager'
    ? 'manager'
    : sender.type === 'staff'
      ? 'staff'
      : 'resident';
}

export class MessageCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No body: the stored replay of a post holds no free text. */
  static from(m: Pick<TicketMessage, 'id' | 'createdAt'>): MessageCreatedView {
    return { id: m.id, createdAt: m.createdAt };
  }
}

/** A message as a resident reads it: never an internal one. */
export class ResidentMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: FirstNameRefView })
  sender: FirstNameRefView;
  @ApiProperty({ enum: SENDER_KINDS })
  senderKind: SenderKind;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its sender was erased.',
  })
  body: string | null;
  @ApiProperty({ type: Boolean })
  deleted: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MessageRead): ResidentMessageView {
    return {
      id: r.message.id,
      sender: firstNameRef(r.sender),
      senderKind: kindOf(r.sender),
      body: r.message.body,
      deleted: r.message.deletedAt !== null,
      createdAt: r.message.createdAt,
    };
  }
}

/** The technician: first names too, and the internal flag. */
export class TechnicianMessageView extends ResidentMessageView {
  @ApiProperty({ type: Boolean, description: 'Staff only.' })
  internal: boolean;

  static from(r: MessageRead): TechnicianMessageView {
    return { ...ResidentMessageView.from(r), internal: r.message.internal };
  }
}

/** Dispatch: full names. */
export class DispatchMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  sender: AccountRefView;
  @ApiProperty({ enum: SENDER_KINDS })
  senderKind: SenderKind;
  @ApiProperty({ type: String, nullable: true })
  body: string | null;
  @ApiProperty({ type: Boolean })
  deleted: boolean;
  @ApiProperty({ type: Boolean, description: 'Staff only.' })
  internal: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: MessageRead): DispatchMessageView {
    return {
      id: r.message.id,
      sender: accountRef(r.sender),
      senderKind: kindOf(r.sender),
      body: r.message.body,
      deleted: r.message.deletedAt !== null,
      internal: r.message.internal,
      createdAt: r.message.createdAt,
    };
  }
}
