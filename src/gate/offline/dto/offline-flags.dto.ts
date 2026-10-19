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

const BATCH_FILTERS = ['pending', 'reviewed', 'all'] as const;

export class OfflineBatchesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: BATCH_FILTERS,
    required: false,
    default: 'all',
    description:
      '`pending`: holding a revoked device’s quarantined actions, to decide.',
  })
  @IsOptional()
  @IsIn(BATCH_FILTERS, withParams({ allowed: [...BATCH_FILTERS] }))
  status?: (typeof BATCH_FILTERS)[number];

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  deviceId?: string;
}

const DECISIONS = ['accept', 'reject'] as const;

export class ReviewOfflineBatchDto {
  @ApiProperty({
    enum: DECISIONS,
    description:
      '`accept`: each quarantined action decided as at its receipt; `reject`: each kept, rejected.',
  })
  @IsIn(DECISIONS, withParams({ allowed: [...DECISIONS] }))
  decision: (typeof DECISIONS)[number];
}

export class ReviewOfflineFlagDto {
  @ApiProperty({
    enum: [...REASON_CODES.offlineFlagReview],
    description: 'What the management made of it, from `offlineFlagReview`.',
  })
  @IsString()
  reviewCode: string;
}
