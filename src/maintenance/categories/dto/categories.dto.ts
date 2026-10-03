import { ApiProperty } from '@nestjs/swagger';
import { TicketPriority } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const NAME = { min: 1, max: 80 };
export const CATEGORY_KEY = /^[a-z][a-z0-9_]{1,39}$/;

export class CreateCategoryDto {
  @ApiProperty({
    type: String,
    pattern: CATEGORY_KEY.source,
    description:
      'Stable code, lowercase (e.g. `pool`). Never changes once created.',
  })
  @IsString()
  @Matches(CATEGORY_KEY)
  key: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn: string;

  @ApiProperty({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    required: false,
    default: 'normal',
  })
  @IsOptional()
  @IsEnum(
    TicketPriority,
    withParams({ allowed: Object.values(TicketPriority) }),
  )
  defaultPriority?: TicketPriority;

  @ApiProperty({ type: Boolean, required: false, default: true })
  @IsOptional()
  @IsBoolean()
  commonAreaAllowed?: boolean;
}

export class UpdateCategoryDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn?: string;

  @ApiProperty({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    TicketPriority,
    withParams({ allowed: Object.values(TicketPriority) }),
  )
  defaultPriority?: TicketPriority;

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  commonAreaAllowed?: boolean;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False retires it: no new ticket under it.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
