import { ApiProperty } from '@nestjs/swagger';
import type { Poll } from '@prisma/client';
import { AudienceView } from '../../audience/audience';
import {
  POLL_STATUSES,
  type PollStatus,
  type ResultsHidden,
} from '../poll-rules';
import type { PollRead, UnitBallot } from '../polls.service';

const HIDDEN = ['not_open', 'not_voted', 'few_votes', 'cancelled'] as const;

export class PollCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No text: the stored replay of a create holds none. */
  static from(p: Pick<Poll, 'id' | 'createdAt'>): PollCreatedView {
    return { id: p.id, createdAt: p.createdAt };
  }
}

/** A vote was taken. Never what it was. */
export class VoteCastView {
  @ApiProperty({ type: String, format: 'uuid' })
  pollId: string;
}

export class PollOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number, description: 'Its place in the list, from 1.' })
  position: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Written by the staff.',
  })
  labelEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  labelAr: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Units that chose it. Null while the results are withheld (`resultsHidden`).',
  })
  votes: number | null;
}

/** One of the caller's units in a poll. */
export class PollUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({
    type: Boolean,
    description: 'The caller casts this unit’s vote in this poll.',
  })
  mayVote: boolean;
  @ApiProperty({ type: Boolean, description: 'The unit has voted.' })
  voted: boolean;
  @ApiProperty({
    type: [String],
    format: 'uuid',
    nullable: true,
    description:
      'The unit’s choice now, to change it knowingly: only while the poll is open and only to those who cast its vote. Null otherwise, and always once the poll has ended: nothing keeps it.',
  })
  choice: string[] | null;

  static from(u: UnitBallot): PollUnitView {
    return {
      unitId: u.unitId,
      mayVote: u.mayVote,
      voted: u.voted,
      choice: u.choice,
    };
  }
}

class PollBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: POLL_STATUSES,
    description:
      '`closed` from its closing time on, or when the staff closed it; `cancelled`: ended with no result.',
  })
  status: PollStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Written by the staff.',
  })
  questionEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  questionAr: string | null;
  @ApiProperty({ type: Boolean, description: 'Several options may be chosen.' })
  multiple: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  opensAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  closesAt: Date;
  @ApiProperty({ type: [PollOptionView] })
  options: PollOptionView[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Units that voted. Null while the results are withheld.',
  })
  turnout: number | null;
  @ApiProperty({
    enum: HIDDEN,
    nullable: true,
    description:
      'Why the counts are withheld, or null when they are shown: `not_open`; `not_voted` (a resident sees an open poll’s counts once one of their units has voted); `few_votes` (fewer than five units have voted on an open poll: shown to nobody); `cancelled`. A closed poll shows everything to everyone.',
  })
  resultsHidden: ResultsHidden;

  static base(r: PollRead): PollBaseView {
    return {
      id: r.poll.id,
      status: r.status,
      questionEn: r.poll.questionEn,
      questionAr: r.poll.questionAr,
      multiple: r.poll.multiple,
      opensAt: r.poll.opensAt,
      closesAt: r.poll.closesAt,
      options: r.options.map((o) => ({
        id: o.id,
        position: o.position,
        labelEn: o.labelEn,
        labelAr: o.labelAr,
        votes: r.counts ? (r.counts.get(o.id) ?? 0) : null,
      })),
      turnout: r.turnout,
      resultsHidden: r.hidden,
    };
  }
}

/** A poll as a resident sees it, with their units in it. */
export class PollView extends PollBaseView {
  @ApiProperty({
    type: [PollUnitView],
    description: 'The caller’s units the poll is put to.',
  })
  units: PollUnitView[];

  static from(r: PollRead): PollView {
    return {
      ...PollBaseView.base(r),
      units: (r.units ?? []).map((u) => PollUnitView.from(u)),
    };
  }
}

/**
 * A poll as the staff see it: counts, never a unit's choice, and not even
 * the counts while fewer than five units have voted on an open poll.
 */
export class StaffPollView extends PollBaseView {
  @ApiProperty({ type: AudienceView })
  audience: AudienceView;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: PollRead): StaffPollView {
    return {
      ...PollBaseView.base(r),
      audience: AudienceView.from(r.poll),
      closedAt: r.poll.closedAt,
      cancelledAt: r.poll.cancelledAt,
      createdAt: r.poll.createdAt,
    };
  }
}

export class PollAudienceView {
  @ApiProperty({
    type: Number,
    description:
      'Units the poll is put to right now: what a turnout is out of.',
  })
  units: number;
}
