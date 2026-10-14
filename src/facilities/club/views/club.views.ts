import { ApiProperty } from '@nestjs/swagger';
import {
  ClubDurationKind,
  ClubPaymentKind,
  type ClubPaymentRecord,
  type ClubPlan,
} from '@prisma/client';
import { firstNameOf } from '../../../core/common/http/personal';
import type { ClubPerson } from '../../../community';
import type { MembershipFile, MembershipState } from '../club.service';

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** A plan as residents see it. */
export class ClubPlanOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ enum: ClubDurationKind, enumName: 'ClubDurationKind' })
  durationKind: ClubDurationKind;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Days, for a custom plan.',
  })
  durationDays: number | null;
  @ApiProperty({
    type: String,
    description: 'EGP, two decimals: what the plan costs at the office.',
  })
  price: string;

  static from(p: ClubPlan): ClubPlanOptionView {
    return {
      id: p.id,
      nameEn: p.nameEn,
      nameAr: p.nameAr,
      durationKind: p.durationKind,
      durationDays: p.durationDays,
      price: p.price.toFixed(2),
    };
  }
}

/** A plan as the staff see it. */
export class ClubPlanView extends ClubPlanOptionView {
  @ApiProperty({
    type: Boolean,
    description: 'False: retired, takes no new payment.',
  })
  active: boolean;

  static from(p: ClubPlan): ClubPlanView {
    return { ...ClubPlanOptionView.from(p), active: p.active };
  }
}

/** A payment or a reversal. Amounts in EGP, two decimals; days are local. */
export class ClubPaymentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ClubPaymentKind, enumName: 'ClubPaymentKind' })
  kind: ClubPaymentKind;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  planId: string | null;
  @ApiProperty({ type: String, nullable: true })
  amount: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  currency: string | null;
  @ApiProperty({ type: String, nullable: true })
  receiptNumber: string | null;
  @ApiProperty({ type: String, nullable: true, description: '`YYYY-MM-DD`.' })
  paidOn: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The first day it pays for.',
  })
  periodStartsOn: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The day after the last it pays for.',
  })
  periodEndsOn: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'A reversal: the payment it reverses.',
  })
  reversesId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A reversal: a code of `clubPaymentReverse`.',
  })
  reasonCode: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'A payment: a reversal reversed it.',
  })
  reversed: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ClubPaymentRecord, reversed: boolean): ClubPaymentView {
    return {
      id: r.id,
      kind: r.kind,
      planId: r.planId,
      amount: r.amount ? r.amount.toFixed(2) : null,
      currency: r.currency,
      receiptNumber: r.receiptNumber,
      paidOn: day(r.paidOn),
      periodStartsOn: day(r.periodStartsOn),
      periodEndsOn: day(r.periodEndsOn),
      reversesId: r.reversesId,
      reasonCode: r.reasonCode,
      reversed,
      createdAt: r.createdAt,
    };
  }

  static list(records: readonly ClubPaymentRecord[]): ClubPaymentView[] {
    const reversed = new Set(records.map((r) => r.reversesId));
    return records.map((r) => ClubPaymentView.from(r, reversed.has(r.id)));
  }
}

/** One of a unit's people, as the accountant sees them: a name, and a minor or not. */
export class ClubPersonView {
  @ApiProperty({ enum: ['occupancy', 'member'], enumName: 'ClubPersonKind' })
  kind: 'occupancy' | 'member';
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The occupancy’s id, or the household member’s.',
  })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once erased.',
  })
  fullName: string | null;
  @ApiProperty({ type: Boolean })
  isMinor: boolean;

  static from(p: ClubPerson): ClubPersonView {
    return { kind: p.kind, id: p.id, fullName: p.fullName, isMinor: p.isMinor };
  }
}

/** A membership as the accountant sees it. */
export class ClubMembershipView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    enum: ['active', 'expiring', 'expired', 'none'],
    enumName: 'ClubMembershipState',
    description:
      '`expiring`: active, ending within seven days. `none`: never paid for.',
  })
  state: MembershipState;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The last day it is active, `YYYY-MM-DD`.',
  })
  activeThrough: string | null;
  @ApiProperty({
    type: [ClubPersonView],
    description: 'Whom it covers, still the unit’s.',
  })
  people: ClubPersonView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(f: MembershipFile): ClubMembershipView {
    return {
      id: f.membership.id,
      unitId: f.membership.unitId,
      unitCode: f.unitCode,
      state: f.state,
      activeThrough: f.activeThrough,
      people: f.people.map((p) => ClubPersonView.from(p)),
      createdAt: f.membership.createdAt,
    };
  }
}

/** A membership with its payments, for the accountant. */
export class ClubMembershipDetailView extends ClubMembershipView {
  @ApiProperty({
    type: [ClubPaymentView],
    description: 'Every payment and reversal, oldest first.',
  })
  payments: ClubPaymentView[];

  static detail(f: MembershipFile): ClubMembershipDetailView {
    return {
      ...ClubMembershipView.from(f),
      payments: ClubPaymentView.list(f.records),
    };
  }
}

/** A unit found by its code, for the accountant. */
export class ClubUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  membershipId: string | null;
}

/** Someone the membership covers, as the unit's people see them: a first name. */
export class ClubCoveredPersonView {
  @ApiProperty({ type: String, nullable: true })
  firstName: string | null;
  @ApiProperty({ type: Boolean, description: 'The caller.' })
  me: boolean;
}

/** The unit's membership as its people see it. */
export class MyClubMembershipView {
  @ApiProperty({
    enum: ['active', 'expiring', 'expired', 'none'],
    enumName: 'ClubMembershipState',
  })
  state: MembershipState;
  @ApiProperty({ type: String, nullable: true })
  activeThrough: string | null;
  @ApiProperty({ type: [ClubCoveredPersonView] })
  people: ClubCoveredPersonView[];
  @ApiProperty({
    type: [ClubPaymentView],
    nullable: true,
    description:
      'Null unless the caller sees the unit’s money (`financeView`).',
  })
  payments: ClubPaymentView[] | null;

  static from(
    f: MembershipFile,
    me: string,
    payments: boolean,
  ): MyClubMembershipView {
    return {
      state: f.state,
      activeThrough: f.activeThrough,
      people: f.people.map((p) => ({
        firstName: firstNameOf(p.fullName),
        me: p.accountId === me,
      })),
      payments: payments ? ClubPaymentView.list(f.records) : null,
    };
  }
}

export class MyClubView {
  @ApiProperty({
    type: MyClubMembershipView,
    nullable: true,
    description: 'Null: the unit has no membership.',
  })
  membership: MyClubMembershipView | null;
}
