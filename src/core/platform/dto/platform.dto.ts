import { ApiProperty } from '@nestjs/swagger';
import { Locale, TenantStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { IdentityDocumentDto } from '../../common/http/identity-document.dto';
import { IsPhone } from '../../common/validation/is-phone';
import { withParams } from '../../common/validation/validation-errors';

export class PlatformLoginDto {
  @ApiProperty({ type: String, maxLength: 254 })
  @IsString()
  @Length(3, 254, withParams({ min: 3, max: 254 }))
  email: string;

  @ApiProperty({ type: String, maxLength: 200 })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  password: string;
}

export class ChangePasswordDto {
  @ApiProperty({ type: String, maxLength: 200 })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  currentPassword: string;

  @ApiProperty({
    type: String,
    maxLength: 200,
    description: 'At least 12 characters (checked by the service).',
  })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  newPassword: string;
}

export class PlatformRefreshDto {
  @ApiProperty({ type: String, minLength: 20, maxLength: 200 })
  @IsString()
  @Length(20, 200, withParams({ min: 20, max: 200 }))
  refreshToken: string;
}

export class NewManagerDto extends IdentityDocumentDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @ApiProperty({ type: String })
  @IsPhone()
  phone: string;

  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: Locale, enumName: 'Locale', required: false })
  @IsOptional()
  @IsEnum(Locale, withParams({ allowed: Object.values(Locale) }))
  preferredLocale?: Locale;
}

export class CreateTenantDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  name: string;

  @ApiProperty({ type: NewManagerDto })
  @ValidateNested()
  @Type(() => NewManagerDto)
  manager: NewManagerDto;
}

export class TenantStatusDto {
  @ApiProperty({ enum: TenantStatus, enumName: 'TenantStatus' })
  @IsEnum(TenantStatus, withParams({ allowed: Object.values(TenantStatus) }))
  status: TenantStatus;
}
