import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { withParams } from '../../common/validation/validation-errors';
import { BULK_MAX, DUE_HOURS_RANGE } from '../staff-inbox.service';
import { INBOX_TYPES, type InboxType } from '../staff-inbox';

const BOOL = ['true', 'false'] as const;

export class StaffInboxQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: INBOX_TYPES,
    enumName: 'InboxType',
    description: 'One type only.',
  })
  @IsOptional()
  @IsIn(INBOX_TYPES, withParams({ allowed: [...INBOX_TYPES] }))
  type?: InboxType;

  @ApiProperty({
    required: false,
    enum: BOOL,
    description: '`true`: only what is past its due time.',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  overdue?: (typeof BOOL)[number];
}

export class InboxDueHoursDto {
  @ApiProperty({ enum: INBOX_TYPES, enumName: 'InboxType' })
  @IsIn(INBOX_TYPES, withParams({ allowed: [...INBOX_TYPES] }))
  type: InboxType;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: DUE_HOURS_RANGE.min,
    maximum: DUE_HOURS_RANGE.max,
    description:
      'Hours from when an item starts waiting to when it is overdue; null goes back to the default.',
  })
  @ValidateIf((o: InboxDueHoursDto) => o.dueHours !== null)
  @IsInt(withParams(DUE_HOURS_RANGE))
  @Min(DUE_HOURS_RANGE.min, withParams(DUE_HOURS_RANGE))
  @Max(DUE_HOURS_RANGE.max, withParams(DUE_HOURS_RANGE))
  dueHours: number | null;
}

/** Changes some types' due times; the others stay. */
export class UpdateInboxSettingsDto {
  @ApiProperty({
    type: [InboxDueHoursDto],
    minItems: 1,
    maxItems: INBOX_TYPES.length,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: INBOX_TYPES.length }))
  @ArrayMaxSize(
    INBOX_TYPES.length,
    withParams({ min: 1, max: INBOX_TYPES.length }),
  )
  @ValidateNested({ each: true })
  @Type(() => InboxDueHoursDto)
  items: InboxDueHoursDto[];
}

export class BulkItemDto {
  @ApiProperty({ enum: INBOX_TYPES, enumName: 'InboxType' })
  @IsIn(INBOX_TYPES, withParams({ allowed: [...INBOX_TYPES] }))
  type: InboxType;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  id: string;
}

export class BulkApproveDto {
  @ApiProperty({ type: [BulkItemDto], minItems: 1, maxItems: BULK_MAX })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: BULK_MAX }))
  @ArrayMaxSize(BULK_MAX, withParams({ min: 1, max: BULK_MAX }))
  @ValidateNested({ each: true })
  @Type(() => BulkItemDto)
  items: BulkItemDto[];
}
