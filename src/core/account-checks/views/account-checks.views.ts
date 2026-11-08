import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../common/http/personal';
import { reference } from '../../staff-inbox/staff-inbox';
import type { AccountCheckSettingsRead } from '../account-checks';
import type {
  LineRead,
  ReviewDetail,
  ReviewRead,
} from '../access-reviews.service';
import {
  DANGLING_REASONS,
  FINDING_STATUSES,
  type FindingRead,
} from '../dangling-accounts.service';

export class AccountCheckSettingsView {
  @ApiProperty({ type: Number })
  idleDays: number;
  @ApiProperty({ type: Number })
  reviewEveryDays: number;

  static from(s: AccountCheckSettingsRead): AccountCheckSettingsView {
    return { idleDays: s.idleDays, reviewEveryDays: s.reviewEveryDays };
  }
}

/** An account of the compound's side that looks dangling (ADR 0090). */
export class DanglingFindingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  account: AccountRefView;
  @ApiProperty({
    enum: ['staff', 'manager', 'contractor'],
    enumName: 'CheckedAccountType',
  })
  accountType: string;
  @ApiProperty({
    enum: DANGLING_REASONS,
    enumName: 'DanglingReason',
    description:
      '`idle`: no sign-in for the compound’s idle days; `never_signed_in`: none within 14 days of its creation; `vendor_suspended`: a contractor whose vendor is suspended.',
  })
  reason: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastActiveAt: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  foundAt: string;
  @ApiProperty({ enum: FINDING_STATUSES, enumName: 'DanglingFindingStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  decidedBy: AccountRefView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it was kept (`danglingKeep`).',
  })
  reasonCode: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Kept: not found again before then.',
  })
  mutedUntil: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  clearedAt: string | null;

  static from(r: FindingRead): DanglingFindingView {
    const f = r.finding;
    return {
      id: f.id,
      account: accountRef(r.account),
      accountType: r.account.type,
      reason: f.reason,
      lastActiveAt: f.lastActiveAt?.toISOString() ?? null,
      foundAt: f.foundAt.toISOString(),
      status: f.status,
      decidedAt: f.decidedAt?.toISOString() ?? null,
      decidedBy: r.decidedBy ? accountRef(r.decidedBy) : null,
      reasonCode: f.reasonCode,
      mutedUntil: f.mutedUntil?.toISOString() ?? null,
      clearedAt: f.clearedAt?.toISOString() ?? null,
    };
  }
}

/** An access review (ADR 0090), its counts. */
export class AccessReviewView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'AR-000001' })
  number: string;
  @ApiProperty({ enum: ['open', 'closed'], enumName: 'AccessReviewStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: string;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null: the sweep opened it.',
  })
  openedBy: AccountRefView | null;
  @ApiProperty({ type: Number })
  lines: number;
  @ApiProperty({ type: Number })
  kept: number;
  @ApiProperty({ type: Number })
  revoked: number;
  @ApiProperty({ type: Number, description: 'Lines whose account left first.' })
  left: number;
  @ApiProperty({ type: Number })
  undecided: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: string | null;

  static from(r: ReviewRead): AccessReviewView {
    const v = r.review;
    return {
      id: v.id,
      number: reference('AR', v.number)!,
      status: v.status,
      openedAt: v.openedAt.toISOString(),
      openedBy: r.openedBy ? accountRef(r.openedBy) : null,
      lines: v.lines,
      kept: v.kept,
      revoked: v.revoked,
      left: v.leftCount,
      undecided: v.lines - v.kept - v.revoked - v.leftCount,
      closedAt: v.closedAt?.toISOString() ?? null,
    };
  }
}

export class AccessReviewRoleView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true, description: 'A system role.' })
  key: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'A custom role.' })
  name: string | null;
}

/** One account of the snapshot, as it was when the review opened. */
export class AccessReviewLineView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  account: AccountRefView;
  @ApiProperty({
    enum: ['staff', 'manager', 'contractor'],
    enumName: 'CheckedAccountType',
  })
  accountType: string;
  @ApiProperty({ type: AccessReviewRoleView })
  role: AccessReviewRoleView;
  @ApiProperty({ type: [String], description: 'The role’s, then.' })
  permissions: string[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastActiveAt: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'The system manager’s line: kept only.',
  })
  protected: boolean;
  @ApiProperty({
    enum: ['keep', 'revoke', 'left'],
    enumName: 'AccessReviewLineDecision',
    nullable: true,
  })
  decision: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  decidedBy: AccountRefView | null;

  static from(r: LineRead): AccessReviewLineView {
    const l = r.line;
    return {
      id: l.id,
      account: accountRef(r.account),
      accountType: l.accountType,
      role: { id: l.roleId, key: l.roleKey, name: l.roleName },
      permissions: l.permissions,
      lastActiveAt: l.lastActiveAt?.toISOString() ?? null,
      protected: l.protected,
      decision: l.decision,
      decidedAt: l.decidedAt?.toISOString() ?? null,
      decidedBy: r.decidedBy ? accountRef(r.decidedBy) : null,
    };
  }
}

export class AccessReviewDetailView extends AccessReviewView {
  @ApiProperty({ type: [AccessReviewLineView] })
  reviewLines: AccessReviewLineView[];

  static fromDetail(r: ReviewDetail): AccessReviewDetailView {
    return {
      ...AccessReviewView.from(r),
      reviewLines: r.lines.map((l) => AccessReviewLineView.from(l)),
    };
  }
}
