import { AccountStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

export class UpdateAccountStatusDto {
  @IsEnum(AccountStatus, withParams({ allowed: Object.values(AccountStatus) }))
  status: AccountStatus;
}
