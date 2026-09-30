import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';
import { IsIn } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

/**
 * The statuses a status write may set. Freezing and erasure have their own
 * flows (ADR 0023): `frozen` through freeze/reactivate, `erased` only
 * through the three-step erasure — never a plain status change.
 */
export const SETTABLE_ACCOUNT_STATUSES = [
  AccountStatus.active,
  AccountStatus.inactive,
] as const;

export type SettableAccountStatus = (typeof SETTABLE_ACCOUNT_STATUSES)[number];

export class UpdateAccountStatusDto {
  @ApiProperty({ enum: SETTABLE_ACCOUNT_STATUSES })
  @IsIn(
    SETTABLE_ACCOUNT_STATUSES,
    withParams({ allowed: [...SETTABLE_ACCOUNT_STATUSES] }),
  )
  status: SettableAccountStatus;
}
