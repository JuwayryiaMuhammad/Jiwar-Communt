import { ApiProperty } from '@nestjs/swagger';
import { GovernancePollKind } from '@prisma/client';
import {
  CONTEST_STATUSES,
  type ContestStatus,
} from '../../contests/contest-rules';
import type { MyUnit, RollCallEntry } from '../../contests/contests.service';
import type { PollRecord } from '../polls.service';

const RESULTS = ['passed', 'failed', 'no_quorum', 'tied'] as const;

export class GovernancePollOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['yes', 'no', 'abstain'],
    description: 'A yes/no poll’s options; null on a choice poll.',
  })
  key: string | null;
  @ApiProperty({ type: String, nullable: true })
  labelEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  labelAr: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Votes, once the poll closed; null before: nobody sees a count while voting is open.',
  })
  votes: number | null;
}

export class GovernanceVoteUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: Boolean })
  voted: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'The caller may cast this unit’s vote now.',
  })
  mayVote: boolean;

  static from(u: MyUnit, open: boolean): GovernanceVoteUnitView {
    return { ...u, mayVote: open && !u.voted };
  }
}

export class GovernanceRollCallView {
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: [String], format: 'uuid', description: 'Option ids.' })
  choice: string[];

  static from(e: RollCallEntry): GovernanceRollCallView {
    return { unitCode: e.unitCode, choice: e.choice };
  }
}

/** A poll as the owners see it (ADR 0051). */
export class GovernancePollView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'GP-0001' })
  reference: string;
  @ApiProperty({ enum: GovernancePollKind, enumName: 'GovernancePollKind' })
  kind: GovernancePollKind;
  @ApiProperty({ type: String, nullable: true })
  titleEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  titleAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyAr: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'A secret ballot: no choice is ever stored with its unit.',
  })
  secret: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      'An open vote: each unit’s choice is shown to the owners once the poll closes. Show the voter a notice before they vote.',
  })
  rollCallPublic: boolean;
  @ApiProperty({ type: Number })
  quorumPct: number;
  @ApiProperty({ type: Number })
  thresholdPct: number;
  @ApiProperty({ type: String, format: 'date-time' })
  opensAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  closesAt: Date;
  @ApiProperty({ enum: CONTEST_STATUSES, enumName: 'GovernanceContestStatus' })
  status: ContestStatus;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Units in the electorate, taken when voting opened.',
  })
  electorate: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Units that voted so far: shown while open, never the counts.',
  })
  turnout: number | null;
  @ApiProperty({ type: [GovernancePollOptionView] })
  options: GovernancePollOptionView[];
  @ApiProperty({
    enum: RESULTS,
    enumName: 'GovernancePollResult',
    nullable: true,
  })
  result: (typeof RESULTS)[number] | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  winningOptionId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From `governancePollCancel`, once cancelled.',
  })
  cancelReasonCode: string | null;
  @ApiProperty({
    type: [GovernanceVoteUnitView],
    description:
      'The units whose vote the caller casts in this poll; none for the staff.',
  })
  myUnits: GovernanceVoteUnitView[];
  @ApiProperty({
    type: [GovernanceRollCallView],
    nullable: true,
    description: 'An open vote’s choices by unit, once closed; null otherwise.',
  })
  rollCall: GovernanceRollCallView[] | null;

  static from(r: PollRecord): GovernancePollView {
    const closed = r.contest.closedAt !== null;
    return {
      id: r.poll.id,
      reference: `GP-${String(r.poll.number).padStart(4, '0')}`,
      kind: r.poll.kind,
      titleEn: r.poll.titleEn,
      titleAr: r.poll.titleAr,
      bodyEn: r.poll.bodyEn,
      bodyAr: r.poll.bodyAr,
      secret: r.contest.secret,
      rollCallPublic: !r.contest.secret,
      quorumPct: r.poll.quorumPct,
      thresholdPct: r.poll.thresholdPct,
      opensAt: r.contest.opensAt,
      closesAt: r.contest.closesAt,
      status: r.status,
      electorate: r.contest.electorate,
      turnout: r.turnout,
      options: r.options.map((o) => ({
        id: o.id,
        key: o.key,
        labelEn: o.labelEn,
        labelAr: o.labelAr,
        votes: closed ? (o.finalCount ?? 0) : null,
      })),
      result: (r.poll.result as GovernancePollView['result']) ?? null,
      winningOptionId: r.poll.winningOptionId,
      cancelReasonCode: r.poll.cancelReasonCode,
      myUnits: (r.myUnits ?? []).map((u) =>
        GovernanceVoteUnitView.from(u, r.status === 'open'),
      ),
      rollCall: r.rollCall?.map((e) => GovernanceRollCallView.from(e)) ?? null,
    };
  }
}

/** A poll as the manager sees it: who put it, too. */
export class StaffGovernancePollView extends GovernancePollView {
  @ApiProperty({ enum: ['manager', 'board'] })
  authorSide: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: PollRecord): StaffGovernancePollView {
    return {
      ...GovernancePollView.from(r),
      authorSide: r.poll.authorSide,
      createdAt: r.poll.createdAt,
    };
  }
}

/** A vote taken: that it was, and when; never what. */
export class GovernanceVoteReceipt {
  @ApiProperty({ type: String, format: 'uuid' })
  pollId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  votedAt: Date | null;
}
