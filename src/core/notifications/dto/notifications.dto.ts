import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../common/http/list';
import { withParams } from '../../common/validation/validation-errors';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '../../preferences/categories';

const BOOL = ['true', 'false'] as const;

export class InboxQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, enum: BOOL })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  unread?: (typeof BOOL)[number];

  @ApiProperty({
    required: false,
    enum: NOTIFICATION_CATEGORIES,
    enumName: 'NotificationCategory',
    description: 'Only the kinds of this delivery category (ADR 0058).',
  })
  @IsOptional()
  @IsIn(
    NOTIFICATION_CATEGORIES,
    withParams({ allowed: [...NOTIFICATION_CATEGORIES] }),
  )
  category?: NotificationCategory;

  @ApiProperty({
    required: false,
    enum: BOOL,
    description:
      '`true`: the archived ones only. By default they are left out.',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  archived?: (typeof BOOL)[number];
}
