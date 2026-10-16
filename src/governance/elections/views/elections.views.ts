import { ApiProperty } from '@nestjs/swagger';
import { GovernanceCandidateStatus } from '@prisma/client';
import { GovernanceVoteUnitView } from '../../polls/views/polls.views';
import { ELECTION_PHASES, type ElectionPhase } from '../election-rules';
import type { CandidateRecord, ElectionRecord } from '../elections.service';

const OUTCOMES = ['elected', 'tied', 'not_elected', 'ineligible'] as const;

/** A candidate as the owners see one: name, statement, and at the close the count. */
export class GovernanceCandidateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once erased.',
  })
  fullName: string | null;
  @ApiProperty({ type: String, nullable: true })
  statement: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Votes, once voting closed; null before.',
  })
  votes: number | null;
  @ApiProperty({
    enum: OUTCOMES,
    enumName: 'GovernanceCandidateOutcome',
    nullable: true,
  })
  outcome: (typeof OUTCOMES)[number] | null;

  static from(c: CandidateRecord): GovernanceCandidateView {
    return {
      id: c.id,
      fullName: c.fullName,
      statement: c.statement,
      votes: c.finalCount,
      outcome: (c.outcome as GovernanceCandidateView['outcome']) ?? null,
    };
  }
}

export class GovernanceCandidacyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: GovernanceCandidateStatus,
    enumName: 'GovernanceCandidateStatus',
  })
  status: GovernanceCandidateStatus;
  @ApiProperty({ type: String, nullable: true })
  statement: string | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
}

class GovernanceElectionFields {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'GE-0001' })
  reference: string;
  @ApiProperty({ type: String, nullable: true })
  titleEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  titleAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  bodyAr: string | null;
  @ApiProperty({ type: Number })
  seats: number;
  @ApiProperty({ type: Number })
  termMonths: number;
  @ApiProperty({ type: String, format: 'date-time' })
  nominationsOpenAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  nominationsCloseAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  votingOpensAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  votingClosesAt: Date;
  @ApiProperty({ enum: ELECTION_PHASES, enumName: 'GovernanceElectionPhase' })
  phase: ElectionPhase;
  @ApiProperty({ type: Number, nullable: true })
  electorate: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Units that voted so far: shown while open, never the counts.',
  })
  turnout: number | null;
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Candidates tied across the last seat, once closed: the board resolves the tie.',
  })
  tiedCandidateIds: string[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  certifiedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The board term it seated.',
  })
  termId: string | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReasonCode: string | null;
}

function fields(r: ElectionRecord): GovernanceElectionFields {
  const e = r.election;
  return {
    id: e.id,
    reference: `GE-${String(e.number).padStart(4, '0')}`,
    titleEn: e.titleEn,
    titleAr: e.titleAr,
    bodyEn: e.bodyEn,
    bodyAr: e.bodyAr,
    seats: e.seats,
    termMonths: e.termMonths,
    nominationsOpenAt: e.nominationsOpenAt,
    nominationsCloseAt: e.nominationsCloseAt,
    votingOpensAt: r.contest.opensAt,
    votingClosesAt: r.contest.closesAt,
    phase: r.phase,
    electorate: r.contest.electorate,
    turnout: r.turnout,
    tiedCandidateIds: r.candidates
      .filter((c) => c.outcome === 'tied')
      .map((c) => c.id),
    certifiedAt: e.certifiedAt,
    termId: r.termId,
    cancelReasonCode: e.cancelReasonCode,
  };
}

/** An election as the owners see it (ADR 0051): only those standing. */
export class GovernanceElectionView extends GovernanceElectionFields {
  @ApiProperty({ type: [GovernanceCandidateView] })
  candidates: GovernanceCandidateView[];
  @ApiProperty({ type: [GovernanceVoteUnitView] })
  myUnits: GovernanceVoteUnitView[];
  @ApiProperty({ type: GovernanceCandidacyView, nullable: true })
  myCandidacy: GovernanceCandidacyView | null;

  static from(r: ElectionRecord): GovernanceElectionView {
    const mine = r.myCandidacy;
    return {
      ...fields(r),
      candidates: r.candidates
        .filter((c) => c.status === 'nominated')
        .map((c) => GovernanceCandidateView.from(c)),
      myUnits: (r.myUnits ?? []).map((u) =>
        GovernanceVoteUnitView.from(u, r.phase === 'voting'),
      ),
      myCandidacy: mine
        ? {
            id: mine.id,
            status: mine.status,
            statement: mine.statement,
            reasonCode: mine.reasonCode,
          }
        : null,
    };
  }
}

export class StaffGovernanceCandidateView extends GovernanceCandidateView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({
    enum: GovernanceCandidateStatus,
    enumName: 'GovernanceCandidateStatus',
  })
  status: GovernanceCandidateStatus;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  nominatedAt: Date;

  static from(c: CandidateRecord): StaffGovernanceCandidateView {
    return {
      ...GovernanceCandidateView.from(c),
      accountId: c.accountId,
      status: c.status,
      reasonCode: c.reasonCode,
      nominatedAt: c.nominatedAt,
    };
  }
}

/** An election as the manager keeps it: every candidacy, ended ones too. */
export class StaffGovernanceElectionView extends GovernanceElectionFields {
  @ApiProperty({ type: [StaffGovernanceCandidateView] })
  candidates: StaffGovernanceCandidateView[];
  @ApiProperty({ enum: ['manager', 'board'] })
  authorSide: string;
  @ApiProperty({ type: String, nullable: true })
  tieReasonCode: string | null;

  static from(r: ElectionRecord): StaffGovernanceElectionView {
    return {
      ...fields(r),
      candidates: r.candidates.map((c) => StaffGovernanceCandidateView.from(c)),
      authorSide: r.election.authorSide,
      tieReasonCode: r.election.tieReasonCode,
    };
  }
}

/** A vote taken: that it was, and when; never what. */
export class GovernanceElectionVoteReceipt {
  @ApiProperty({ type: String, format: 'uuid' })
  electionId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  votedAt: Date | null;
}
