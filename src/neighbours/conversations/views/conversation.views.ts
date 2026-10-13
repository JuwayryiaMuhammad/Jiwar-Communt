import { ApiProperty } from '@nestjs/swagger';
import {
  NeighbourPostKind,
  NeighbourReportStatus,
  type NeighbourConversation,
  type NeighbourConversationMessage,
  type NeighbourConversationReport,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { POST_STATES, type PostState } from '../../posts/post-rules';
import type { BlockRead } from '../blocks.service';
import type {
  ConversationMessageRead,
  ConversationRead,
} from '../conversations.service';
import type { ConversationSide } from '../masking';
import type { ReportedMessageRead, ReportRead } from '../reports.service';

const SIDES = ['author', 'responder'] as const;

// ============================================================================
// What a side of a masked conversation is shown (ADR 0042). No view here
// has a field for an account id, a full name, a phone, an email or a unit
// of the other side: there is nowhere for one to leak into. The staff's
// views, at the end, are reached only through a report.
// ============================================================================

/** The answer to starting a conversation, or writing in one. No words. */
export class ConversationCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(
    c: Pick<
      NeighbourConversation | NeighbourConversationMessage,
      'id' | 'createdAt'
    >,
  ): ConversationCreatedView {
    return { id: c.id, createdAt: c.createdAt };
  }
}

/** The other side: "a resident of building X", and a first name once both agreed. */
export class MaskedPartyView {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The building they wrote from. Null when their unit names none.',
  })
  building: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Their first name: only once BOTH sides agreed to show names. Null before.',
  })
  firstName: string | null;
}

export class ConversationPostRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: NeighbourPostKind, enumName: 'NeighbourPostKind' })
  kind: NeighbourPostKind;
  @ApiProperty({ enum: POST_STATES })
  state: PostState;
}

export class ConversationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: ConversationPostRefView })
  post: ConversationPostRefView;
  @ApiProperty({
    enum: SIDES,
    description: 'The caller’s side: the post’s `author`, or the `responder`.',
  })
  side: ConversationSide;
  @ApiProperty({
    type: Boolean,
    description:
      'Something may still be written. False once it closed or its post left the board; never says which.',
  })
  open: boolean;
  @ApiProperty({ type: MaskedPartyView })
  other: MaskedPartyView;
  @ApiProperty({ type: Boolean, description: 'Both agreed: names are shown.' })
  namesRevealed: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'The caller agreed to show names.',
  })
  iAgreed: boolean;
  @ApiProperty({ type: Boolean, description: 'The other side agreed.' })
  theyAgreed: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  lastMessageAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ConversationRead): ConversationView {
    return {
      id: r.conversation.id,
      post: { id: r.post.id, kind: r.post.kind, state: r.postState },
      side: r.side,
      open: r.open,
      other: { building: r.other.building, firstName: r.other.firstName },
      namesRevealed: r.namesRevealed,
      iAgreed: r.iAgreed,
      theyAgreed: r.theyAgreed,
      lastMessageAt: r.conversation.lastMessageAt,
      createdAt: r.conversation.createdAt,
    };
  }
}

/** A message as a side reads it: the caller's or the other's, and no sender. */
export class ConversationMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Boolean, description: 'The caller wrote it.' })
  mine: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its sender was erased.',
  })
  body: string | null;
  @ApiProperty({ type: Boolean })
  erased: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ConversationMessageRead): ConversationMessageView {
    return {
      id: r.message.id,
      mine: r.mine,
      body: r.message.body,
      erased: r.message.erasedAt !== null,
      createdAt: r.message.createdAt,
    };
  }
}

/** One of the caller's blocks: who it keeps away is a building, never a name. */
export class BlockView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The building the blocked resident wrote from.',
  })
  building: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: BlockRead): BlockView {
    return {
      id: r.block.id,
      building: r.building,
      createdAt: r.block.createdAt,
    };
  }
}

/** The answer to reporting. */
export class ReportCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(
    r: Pick<NeighbourConversationReport, 'id' | 'createdAt'>,
  ): ReportCreatedView {
    return { id: r.id, createdAt: r.createdAt };
  }
}

// ----------------------------------------------------------------------------
// The staff, through a report and nothing else.
// ----------------------------------------------------------------------------

export class ReportPartyView {
  @ApiProperty({ type: AccountRefView })
  account: AccountRefView;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
}

export class ReportPostView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: NeighbourPostKind, enumName: 'NeighbourPostKind' })
  kind: NeighbourPostKind;
  @ApiProperty({ type: String, nullable: true })
  body: string | null;
  @ApiProperty({ enum: POST_STATES })
  state: PostState;
}

/** A reported conversation's case, as the staff read it. */
export class StaffReportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: NeighbourReportStatus,
    enumName: 'NeighbourReportStatus',
  })
  status: NeighbourReportStatus;
  @ApiProperty({
    type: String,
    description: 'A code of `neighbourConversationReport`.',
  })
  reasonCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the reporter told the staff.',
  })
  note: string | null;
  @ApiProperty({ type: AccountRefView })
  reporter: AccountRefView;
  @ApiProperty({ enum: SIDES })
  reporterSide: ConversationSide;
  @ApiProperty({ type: String, format: 'uuid' })
  conversationId: string;
  @ApiProperty({ type: ReportPartyView, description: 'Who posted.' })
  author: ReportPartyView;
  @ApiProperty({ type: ReportPartyView, description: 'Who wrote to them.' })
  responder: ReportPartyView;
  @ApiProperty({ type: ReportPostView })
  post: ReportPostView;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A code of `neighbourReportOutcome`, once closed.',
  })
  outcome: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  closedBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ReportRead): StaffReportView {
    return {
      id: r.report.id,
      status: r.report.status,
      reasonCode: r.report.reasonCode,
      note: r.report.note,
      reporter: accountRef(r.reporter),
      reporterSide: r.reporterSide,
      conversationId: r.conversation.id,
      author: {
        account: accountRef(r.author),
        unitCode: r.authorUnit?.code ?? null,
        building: r.authorUnit?.building ?? null,
      },
      responder: {
        account: accountRef(r.responder),
        unitCode: r.responderUnit?.code ?? null,
        building: r.responderUnit?.building ?? null,
      },
      post: {
        id: r.post.id,
        kind: r.post.kind,
        body: r.post.body,
        state: r.postState,
      },
      outcome: r.report.outcome,
      closedBy: r.closedBy && accountRef(r.closedBy),
      closedAt: r.report.closedAt,
      createdAt: r.report.createdAt,
    };
  }
}

/** A message of a reported conversation, as the staff read it. */
export class ReportedMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  sender: AccountRefView;
  @ApiProperty({ enum: SIDES })
  side: ConversationSide;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its sender was erased.',
  })
  body: string | null;
  @ApiProperty({ type: Boolean })
  erased: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ReportedMessageRead): ReportedMessageView {
    return {
      id: r.message.id,
      sender: accountRef(r.sender),
      side: r.side,
      body: r.message.body,
      erased: r.message.erasedAt !== null,
      createdAt: r.message.createdAt,
    };
  }
}
