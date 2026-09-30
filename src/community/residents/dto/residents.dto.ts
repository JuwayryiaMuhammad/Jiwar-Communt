import { ApiProperty } from '@nestjs/swagger';
import { Locale, OccupancyType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { IdentityDocumentDto } from '../../../core/common/http/identity-document.dto';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';

export class OccupancyInputDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;

  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  @IsEnum(OccupancyType, withParams({ allowed: Object.values(OccupancyType) }))
  occupancyType: OccupancyType;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Owners only: false = a landlord.',
  })
  @IsOptional()
  @IsBoolean()
  resides?: boolean;
}

export class CreateResidentDto extends IdentityDocumentDto {
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

  @ApiProperty({
    type: [OccupancyInputDto],
    description: 'At least one (checked by the service).',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OccupancyInputDto)
  units: OccupancyInputDto[];
}
