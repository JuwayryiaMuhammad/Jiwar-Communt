import { ApiProperty } from '@nestjs/swagger';
import { BoardRole, BoardTermSource } from '@prisma/client';
import type { GovernanceOwner } from '../../../community';
import type { SeatRecord, TermRecord } from '../board.service';

const TERM_STATUSES = ['current', 'lapsed', 'ended'] as const;

/** A seat as the owners see it: who and which role, nothing else. */
export class BoardSeatView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: BoardRole, enumName: 'BoardRole' })
  role: BoardRole;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the account was erased.',
  })
  fullName: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the seat ended before its term did.',
  })
  endedAt: Date | null;

  static from(s: SeatRecord): BoardSeatView {
    return {
      id: s.id,
      role: s.role,
      fullName: s.fullName,
      addedAt: s.addedAt,
      endedAt: s.endedAt,
    };
  }
}

class BoardTermFields {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: BoardTermSource, enumName: 'BoardTermSource' })
  source: BoardTermSource;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  electionId: string | null;
  @ApiProperty({ type: Number })
  seats: number;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the next board took over.',
  })
  endedAt: Date | null;
  @ApiProperty({
    enum: TERM_STATUSES,
    enumName: 'BoardTermStatus',
    description:
      '`lapsed`: past its end with no board after it; its members hold nothing until one is appointed or elected.',
  })
  status: (typeof TERM_STATUSES)[number];
}

/** A board's term as the owners see it: its seated members, or all of a past one. */
export class BoardTermView extends BoardTermFields {
  @ApiProperty({ type: [BoardSeatView] })
  members: BoardSeatView[];

  static from(r: TermRecord): BoardTermView {
    return {
      ...termFields(r),
      // A sitting board shows who sits; a past one, everyone who sat.
      members: r.members
        .filter((m) => r.status !== 'current' || !m.endedAt)
        .map((m) => BoardSeatView.from(m)),
    };
  }
}

/** `GET /governance/board`: the board sitting now, or none. */
export class BoardNowView {
  @ApiProperty({ type: BoardTermView, nullable: true })
  board: BoardTermView | null;
}

/** A seat as the manager keeps it. */
export class StaffBoardSeatView extends BoardSeatView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From `boardMemberEnd` or `boardMemberSystemEnd`.',
  })
  endReason: string | null;

  static from(s: SeatRecord): StaffBoardSeatView {
    return {
      ...BoardSeatView.from(s),
      accountId: s.accountId,
      endReason: s.endReason,
    };
  }
}

export class StaffBoardTermView extends BoardTermFields {
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['succeeded', 'replaced'],
  })
  endReason: string | null;
  @ApiProperty({
    type: [StaffBoardSeatView],
    description: 'Every seat, ended ones too.',
  })
  members: StaffBoardSeatView[];

  static from(r: TermRecord): StaffBoardTermView {
    return {
      ...termFields(r),
      endReason: r.term.endReason,
      members: r.members.map((m) => StaffBoardSeatView.from(m)),
    };
  }
}

export class StaffBoardNowView {
  @ApiProperty({
    type: StaffBoardTermView,
    nullable: true,
    description:
      'The open term, current or lapsed; null before the first board.',
  })
  board: StaffBoardTermView | null;
}

export class GovernanceOwnerView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ type: [String] })
  unitCodes: string[];

  static from(o: GovernanceOwner): GovernanceOwnerView {
    return { ...o };
  }
}

function termFields(r: TermRecord): BoardTermFields {
  return {
    id: r.term.id,
    source: r.term.source,
    electionId: r.term.electionId,
    seats: r.term.seats,
    startsAt: r.term.startsAt,
    endsAt: r.term.endsAt,
    endedAt: r.term.endedAt,
    status: r.status,
  };
}
