import { ApiProperty } from '@nestjs/swagger';
import { HouseholdMemberStatus, HouseholdRelation } from '@prisma/client';
import type {
  CreatedInvite,
  HouseholdMemberView,
  HouseholdView,
  MemberGrantSummary,
  PendingInviteView,
  PendingMember,
} from '../households.types';

const PERMISSIONS = [
  'visitors_invite',
  'bookings',
  'tickets',
  'finance',
  'unit_security',
];

export class GrantSummaryView {
  @ApiProperty({ enum: PERMISSIONS })
  permission: string;
  @ApiProperty({ type: String, nullable: true, description: 'Finance only.' })
  capPerOperation: string | null;

  static from(g: MemberGrantSummary): GrantSummaryView {
    return { permission: g.permission, capPerOperation: g.capPerOperation };
  }
}

/** A household member: names, relation, the minor flag; never contact data. */
export class HouseholdMemberItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ enum: HouseholdRelation, enumName: 'HouseholdRelation' })
  relation: HouseholdRelation;
  @ApiProperty({ type: Boolean })
  isMinor: boolean;
  @ApiProperty({
    enum: HouseholdMemberStatus,
    enumName: 'HouseholdMemberStatus',
  })
  status: HouseholdMemberStatus;
  @ApiProperty({
    type: [GrantSummaryView],
    required: false,
    description: 'The primary or a household delegate only.',
  })
  permissions?: GrantSummaryView[];

  static from(
    m: HouseholdMemberView & { grants?: MemberGrantSummary[] },
  ): HouseholdMemberItemView {
    return {
      id: m.id,
      fullName: m.fullName,
      relation: m.relation,
      isMinor: m.isMinor,
      status: m.status,
      ...(m.grants
        ? { permissions: m.grants.map((g) => GrantSummaryView.from(g)) }
        : {}),
    };
  }
}

/** The invitee by name and relation; never their phone, email or document. */
export class PendingInviteResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ enum: HouseholdRelation, enumName: 'HouseholdRelation' })
  relation: HouseholdRelation;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(i: PendingInviteView): PendingInviteResponse {
    return {
      id: i.id,
      fullName: i.fullName,
      relation: i.relation,
      expiresAt: i.expiresAt,
    };
  }
}

export class HouseholdResponse {
  @ApiProperty({ type: [HouseholdMemberItemView] })
  members: HouseholdMemberItemView[];
  @ApiProperty({
    type: [PendingInviteResponse],
    required: false,
    description: 'The primary or a household delegate only.',
  })
  invites?: PendingInviteResponse[];

  static from(h: HouseholdView): HouseholdResponse {
    return {
      members: h.members.map((m) => HouseholdMemberItemView.from(m)),
      ...(h.invites
        ? { invites: h.invites.map((i) => PendingInviteResponse.from(i)) }
        : {}),
    };
  }
}

export class HouseholdMemberResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ enum: HouseholdRelation, enumName: 'HouseholdRelation' })
  relation: HouseholdRelation;
  @ApiProperty({ type: Boolean })
  isMinor: boolean;
  @ApiProperty({
    enum: HouseholdMemberStatus,
    enumName: 'HouseholdMemberStatus',
  })
  status: HouseholdMemberStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(m: HouseholdMemberView): HouseholdMemberResponse {
    return {
      id: m.id,
      fullName: m.fullName,
      relation: m.relation,
      isMinor: m.isMinor,
      status: m.status,
      createdAt: m.createdAt,
    };
  }
}

/** The invitation link's token, shown once (no-store). */
export class CreatedInviteView {
  @ApiProperty({ type: String, format: 'uuid' })
  inviteId: string;
  @ApiProperty({
    type: String,
    description: 'Shown once; only its hash is stored.',
  })
  token: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(i: CreatedInvite): CreatedInviteView {
    return { inviteId: i.inviteId, token: i.token, expiresAt: i.expiresAt };
  }
}

export class PendingMemberView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ enum: HouseholdRelation, enumName: 'HouseholdRelation' })
  relation: HouseholdRelation;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;

  static from(p: PendingMember): PendingMemberView {
    return {
      memberId: p.memberId,
      unitId: p.unitId,
      unitCode: p.unitCode,
      fullName: p.fullName,
      relation: p.relation,
      requestedAt: p.requestedAt,
    };
  }
}
