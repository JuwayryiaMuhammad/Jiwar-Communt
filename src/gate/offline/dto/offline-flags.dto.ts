import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';

const STATUSES = ['open', 'cleared', 'reviewed', 'all'] as const;
const CLASSES = ['security', 'manager', 'info'] as const;

export class OfflineFlagsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: STATUSES,
    required: false,
    default: 'all',
    description:
      '`open`: neither reviewed nor cleared; `cleared`: an exit whose entry arrived later.',
  })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];

  @ApiProperty({ enum: CLASSES, required: false })
  @IsOptional()
  @IsIn(CLASSES, withParams({ allowed: [...CLASSES] }))
  class?: (typeof CLASSES)[number];

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

export class ReviewOfflineFlagDto {
  @ApiProperty({
    enum: [...REASON_CODES.offlineFlagReview],
    description: 'What the management made of it, from `offlineFlagReview`.',
  })
  @IsString()
  reviewCode: string;
}
