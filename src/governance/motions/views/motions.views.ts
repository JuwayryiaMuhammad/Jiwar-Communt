import { ApiProperty } from '@nestjs/swagger';
import { VOTE_CHOICES } from '../dto/motions.dto';
import type { MotionRecord, MotionStatus } from '../motions.service';

const STATUSES = ['open', 'carried', 'failed', 'withdrawn', 'lapsed'] as const;
const OUTCOMES = ['approve', 'reject', 'uphold', 'overturn'] as const;

export class BoardVoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the member’s account is erased.',
  })
  fullName: string | null;
  @ApiProperty({ enum: VOTE_CHOICES, enumName: 'BoardVoteChoice' })
  choice: (typeof VOTE_CHOICES)[number];
  @ApiProperty({ type: String, format: 'date-time' })
  castAt: Date;
}

export class BoardTallyView {
  @ApiProperty({
    type: Number,
    description: 'Seats that count: seated now (as closed, once closed).',
  })
  seats: number;
  @ApiProperty({ type: Number })
  quorum: number;
  @ApiProperty({ type: Number })
  for: number;
  @ApiProperty({ type: Number })
  against: number;
}

/** A motion of the board (ADR 0055): the board's eyes only. */
export class BoardMotionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: OUTCOMES, enumName: 'BoardMotionOutcome' })
  outcome: (typeof OUTCOMES)[number];
  @ApiProperty({ type: String })
  rationale: string;
  @ApiProperty({ type: String, nullable: true })
  alternativesNote: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  proposedByMemberId: string;
  @ApiProperty({ type: String, nullable: true })
  proposedByName: string | null;
  @ApiProperty({ enum: STATUSES, enumName: 'BoardMotionStatus' })
  status: MotionStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: [BoardVoteView] })
  votes: BoardVoteView[];
  @ApiProperty({ type: BoardTallyView })
  tally: BoardTallyView;
  @ApiProperty({
    enum: VOTE_CHOICES,
    enumName: 'BoardVoteChoice',
    nullable: true,
    description: 'The caller’s vote, if any.',
  })
  myVote: (typeof VOTE_CHOICES)[number] | null;
  @ApiProperty({
    type: Number,
    description:
      'Accounts recused from it (an appeal’s: its unit’s people and the appellant), fixed when it opened.',
  })
  recused: number;
  @ApiProperty({
    type: Boolean,
    description:
      'The caller is recused: no vote, no close (BOARD_MEMBER_RECUSED).',
  })
  myRecusal: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'The caller proposed it: only they withdraw it.',
  })
  proposedByMe: boolean;

  static from(r: MotionRecord): BoardMotionView {
    const m = r.motion;
    return {
      id: m.id,
      outcome: m.outcome as BoardMotionView['outcome'],
      rationale: m.rationale,
      alternativesNote: m.alternativesNote,
      proposedByMemberId: r.proposer.memberId,
      proposedByName: r.proposer.fullName,
      status: (m.result ?? 'open') as MotionStatus,
      openedAt: m.openedAt,
      closedAt: m.closedAt,
      votes: r.votes.map((v) => ({
        memberId: v.memberId,
        fullName: v.fullName,
        choice: v.choice as BoardVoteView['choice'],
        castAt: v.castAt,
      })),
      tally: {
        seats: r.tally.n,
        quorum: r.tally.quorum,
        for: r.tally.for,
        against: r.tally.against,
      },
      myVote: r.mine.voted,
      recused: r.recused,
      myRecusal: r.mine.recused,
      proposedByMe: r.mine.proposed,
    };
  }
}
