import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ToInstant } from '../../../core/common/validation/instant';

export class RegisterFoundItemDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  description: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Where it was found: a place in service.',
  })
  @IsOptional()
  @IsUUID()
  placeId?: string;

  @ApiPropertyOptional({ type: String, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  location?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'When it was found; default now, never later.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  foundAt?: Date;

  @ApiPropertyOptional({
    type: [String],
    description: 'Finalized `found_item_photo` files of the caller, 3 at most.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, withParams({ min: 0, max: 3 }))
  @IsUUID(undefined, { each: true })
  photoFileIds?: string[];
}

export class ClaimFoundItemDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 40,
    description:
      'The owner’s unit (UNIT_CODE_UNKNOWN). With `name`, one at least.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 40, withParams({ min: 1, max: 40 }))
  unitCode?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 80,
    description: 'As the claimant gives it; kept 30 days.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80, withParams({ min: 1, max: 80 }))
  name?: string;

  @ApiPropertyOptional({ type: String, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  note?: string;
}

const STATUSES = ['at_gate', 'with_management', 'claimed'] as const;

export class FoundItemsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];
}
