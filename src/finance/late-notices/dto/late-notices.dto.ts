import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CURE_DAYS } from '../late-notices.service';

export class NoticeSettingsDto {
  @ApiProperty({
    type: Number,
    minimum: CURE_DAYS.min,
    maximum: CURE_DAYS.max,
    description:
      'Days after an invoice’s due date before its formal late-payment notice (the cure period).',
  })
  @IsInt(withParams({ ...CURE_DAYS }))
  @Min(CURE_DAYS.min, withParams({ ...CURE_DAYS }))
  @Max(CURE_DAYS.max, withParams({ ...CURE_DAYS }))
  lateNoticeCureDays: number;
}
