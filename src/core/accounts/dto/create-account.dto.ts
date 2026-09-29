import { AccountType } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsPhoneNumber,
  IsString,
  Length,
} from 'class-validator';
import { IsEgyptianNationalId } from '../../common/validation/is-egyptian-national-id';
import { withParams } from '../../common/validation/validation-errors';

/** Manager-only (ADR 0003). No tenantId: it always comes from the token. */
export class CreateAccountDto {
  @IsEnum(AccountType, withParams({ allowed: Object.values(AccountType) }))
  type: AccountType;

  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  /** Egyptian national ID (14 digits). Stays inside tenant data (ADR 0002). */
  @IsString()
  @IsEgyptianNationalId()
  nationalId: string;

  /** Local Egyptian format or international (+…); stored as E.164. */
  @IsPhoneNumber('EG')
  phone: string;

  @IsEmail()
  email: string;
}
