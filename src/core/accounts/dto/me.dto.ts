import { ApiProperty } from '@nestjs/swagger';
import { Locale } from '@prisma/client';
import { IsEnum, IsString, Length } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';

export class UpdateLocaleDto {
  @ApiProperty({ enum: Locale, enumName: 'Locale' })
  @IsEnum(Locale, withParams({ allowed: Object.values(Locale) }))
  locale: Locale;
}

export class DeletionConfirmationDto {
  @ApiProperty({
    type: String,
    description: 'The word the holder types: `حذف` or `DELETE`.',
  })
  @IsString()
  @Length(1, 50, withParams({ min: 1, max: 50 }))
  confirmation: string;
}
