import { ApiProperty } from '@nestjs/swagger';
import { DelegationScope, UnitType } from '@prisma/client';
import { AccountRefView, accountRef } from '../../../core/common/http/personal';
import type { MyDelegation } from '../../households/delegations.service';
import type {
  MemberGrantView,
  MyPermissions,
} from '../../households/member-permissions.service';
import type { MyUnit, MyUnitStatus } from '../residents.types';

export class HouseholdSummaryView {
  @ApiProperty({ type: Number })
  memberCount: number;
  @ApiProperty({ type: Number })
  pendingInvites: number;
}

export class MyUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: Number, nullable: true })
  floor: number | null;
  @ApiProperty({ enum: UnitType, enumName: 'UnitType', nullable: true })
  unitType: UnitType | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '120.50',
    description: 'Square metres; the app converts for display.',
  })
  areaSqm: string | null;
  @ApiProperty({
    enum: ['active', 'closed'],
    description: '`closed` while the unit is in closed-unit mode.',
  })
  status: MyUnitStatus;
  @ApiProperty({ enum: ['owner', 'tenant', 'member'] })
  capacity: 'owner' | 'tenant' | 'member';
  @ApiProperty({
    type: Boolean,
    description: 'False only for an owner-landlord.',
  })
  resides: boolean;
  @ApiProperty({ type: Boolean })
  isPrimary: boolean;
  @ApiProperty({
    type: HouseholdSummaryView,
    required: false,
    description: 'The primary only.',
  })
  household?: HouseholdSummaryView;

  static from(u: MyUnit): MyUnitView {
    return {
      unitId: u.unitId,
      code: u.code,
      building: u.building,
      floor: u.floor,
      unitType: u.unitType,
      areaSqm: u.areaSqm,
      status: u.status,
      capacity: u.capacity,
      resides: u.resides,
      isPrimary: u.isPrimary,
      ...(u.household
        ? {
            household: {
              memberCount: u.household.memberCount,
              pendingInvites: u.household.pendingInvites,
            },
          }
        : {}),
    };
  }
}

export class MemberGrantResponse {
  @ApiProperty({
    enum: [
      'visitors_invite',
      'bookings',
      'tickets',
      'finance',
      'unit_security',
    ],
  })
  permission: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Finance only: the cap per operation.',
  })
  capPerOperation: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  grantedAt: Date;

  static from(g: MemberGrantView): MemberGrantResponse {
    return {
      permission: g.permission,
      capPerOperation: g.capPerOperation,
      grantedAt: g.grantedAt,
    };
  }
}

export class MyPermissionsView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: [MemberGrantResponse] })
  grants: MemberGrantResponse[];
  @ApiProperty({ type: [String], description: 'Never revocable.' })
  baseline: string[];
  @ApiProperty({
    type: [String],
    description: 'What the primary manages, never the member.',
  })
  managedByPrimary: string[];

  static from(p: MyPermissions): MyPermissionsView {
    return {
      memberId: p.memberId,
      grants: p.grants.map((g) => MemberGrantResponse.from(g)),
      baseline: [...p.baseline],
      managedByPrimary: [...p.managedByPrimary],
    };
  }
}

export class MyDelegationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: ['delegate', 'delegator'] })
  role: 'delegate' | 'delegator';
  @ApiProperty({
    type: AccountRefView,
    description: 'The other side, by name only.',
  })
  counterpart: AccountRefView;
  @ApiProperty({
    enum: DelegationScope,
    enumName: 'DelegationScope',
    isArray: true,
  })
  scopes: DelegationScope[];
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(d: MyDelegation): MyDelegationView {
    return {
      id: d.id,
      unitId: d.unitId,
      unitCode: d.unitCode,
      role: d.role,
      counterpart: accountRef(d.counterpart),
      scopes: d.scopes,
      expiresAt: d.expiresAt,
    };
  }
}
