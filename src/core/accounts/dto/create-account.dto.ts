import { AccountType } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

/** Manager-only (ADR 0003). No tenantId: it always comes from the token. */
export class CreateAccountDto {
  @IsEnum(AccountType, withParams({ allowed: Object.values(AccountType) }))
  type: AccountType;

  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  /** National ID or passport number. Stays inside tenant data (ADR 0002). */
  @IsString()
  @Matches(/^[A-Za-z0-9]{5,32}$/, {
    message: 'nationalId must be 5-32 letters or digits',
    ...withParams({ min: 5, max: 32 }),
  })
  nationalId: string;

  /** Local Egyptian format or international (+…); stored as E.164. */
  @IsPhoneNumber('EG')
  phone: string;

  @IsEmail()
  email: string;
}
