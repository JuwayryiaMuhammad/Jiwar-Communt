import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';

export class RequestSwapDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'One of my slots: scheduled, unopened and to come (SLOT_NOT_SWAPPABLE).',
  })
  @IsUUID()
  slotId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active guard (GUARD_NOT_ELIGIBLE).',
  })
  @IsUUID()
  colleagueId: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'One of the colleague’s slots, in exchange. Absent: the colleague covers mine.',
  })
  @IsOptional()
  @IsUUID()
  colleagueSlotId?: string;

  @ApiPropertyOptional({ type: String, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  reason?: string;
}

export class RejectSwapDto {
  @ApiProperty({
    enum: [...REASON_CODES.guardSwapReject],
    enumName: 'GuardSwapReject',
  })
  @IsString()
  reasonCode: string;
}

const STATUSES = [
  'requested',
  'accepted',
  'approved',
  'declined',
  'rejected',
  'withdrawn',
  'cancelled',
  'expired',
] as const;

export class StaffSwapsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: STATUSES,
    description: '`accepted`: those to decide.',
  })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];
}
