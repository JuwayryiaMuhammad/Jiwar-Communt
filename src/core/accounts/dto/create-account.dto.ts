import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({ enum: AccountType, enumName: 'AccountType' })
  @IsEnum(AccountType, withParams({ allowed: Object.values(AccountType) }))
  type: AccountType;

  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  @IsEnum(
    IdDocumentType,
    withParams({ allowed: Object.values(IdDocumentType) }),
  )
  idDocumentType: IdDocumentType;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 40,
    description: '14-digit national ID, or a passport number.',
  })
  @IsString()
  @Length(1, 40, withParams({ min: 1, max: 40 }))
  idDocumentNumber: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'ISO 3166-1 alpha-2; required for a passport.',
  })
  @IsOptional()
  @IsString()
  nationality?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'Required for a passport, ignored for a national ID.',
  })
  @IsOptional()
  @IsString()
  birthDate?: string;

  @ApiProperty({
    type: String,
    description:
      'Local Egyptian format, or international with `+`; stored as E.164.',
  })
  @IsPhone()
  phone: string;

  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;
}
