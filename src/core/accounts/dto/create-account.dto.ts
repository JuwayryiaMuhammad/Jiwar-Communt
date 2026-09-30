import { AccountType, IdDocumentType } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { IsPhone } from '../../common/validation/is-phone';
import { withParams } from '../../common/validation/validation-errors';

/**
 * Manager-only (ADR 0003). No tenantId: it always comes from the token.
 * The identity document is validated as a whole by parseIdentityDocument
 * (ADR 0018), which returns the same field codes.
 */
export class CreateAccountDto {
  @IsEnum(AccountType, withParams({ allowed: Object.values(AccountType) }))
  type: AccountType;

  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @IsEnum(
    IdDocumentType,
    withParams({ allowed: Object.values(IdDocumentType) }),
  )
  idDocumentType: IdDocumentType;

  /** 14-digit national ID, or a passport number. Stays inside tenant data (ADR 0002). */
  @IsString()
  @Length(1, 40, withParams({ min: 1, max: 40 }))
  idDocumentNumber: string;

  /** ISO 3166-1 alpha-2; required for a passport. */
  @IsOptional()
  @IsString()
  nationality?: string;

  /** `YYYY-MM-DD`; required for a passport, ignored for a national ID. */
  @IsOptional()
  @IsString()
  birthDate?: string;

  /** Local Egyptian format, or international with `+`; stored as E.164. */
  @IsPhone()
  phone: string;

  @IsEmail()
  email: string;
}
