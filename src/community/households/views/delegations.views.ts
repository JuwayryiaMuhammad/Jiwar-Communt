import { ApiProperty } from '@nestjs/swagger';
import { DelegationScope } from '@prisma/client';
import { AccountRefView, accountRef } from '../../../core/common/http/personal';
import type { DelegationView, UnitDelegation } from '../delegations.service';

export class UnitDelegationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView, description: 'By name only.' })
  delegate: AccountRefView;
  @ApiProperty({
    enum: DelegationScope,
    enumName: 'DelegationScope',
    isArray: true,
  })
  scopes: DelegationScope[];
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(d: UnitDelegation): UnitDelegationView {
    return {
      id: d.id,
      delegate: accountRef(d.delegate),
      scopes: d.scopes,
      expiresAt: d.expiresAt,
      createdAt: d.createdAt,
    };
  }
}

export class CreatedDelegationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  delegateAccountId: string;
  @ApiProperty({
    enum: DelegationScope,
    enumName: 'DelegationScope',
    isArray: true,
  })
  scopes: DelegationScope[];
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(d: DelegationView): CreatedDelegationView {
    return {
      id: d.id,
      unitId: d.unitId,
      delegateAccountId: d.delegateAccountId,
      scopes: d.scopes,
      expiresAt: d.expiresAt,
    };
  }
}
