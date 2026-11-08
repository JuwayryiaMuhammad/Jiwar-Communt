import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';
import { IDLE_DAYS, REVIEW_EVERY_DAYS } from '../account-checks';
import { FINDING_STATUSES } from '../dangling-accounts.service';

export class UpdateAccountCheckSettingsDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: IDLE_DAYS.min,
    maximum: IDLE_DAYS.max,
    description:
      'Days without a sign-in that make an account of the compound’s side dangling.',
  })
  @IsOptional()
  @IsInt()
  @Min(IDLE_DAYS.min, withParams({ min: IDLE_DAYS.min, max: IDLE_DAYS.max }))
  @Max(IDLE_DAYS.max, withParams({ min: IDLE_DAYS.min, max: IDLE_DAYS.max }))
  idleDays?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: REVIEW_EVERY_DAYS.min,
    maximum: REVIEW_EVERY_DAYS.max,
    description: 'Every how many days an access review opens.',
  })
  @IsOptional()
  @IsInt()
  @Min(
    REVIEW_EVERY_DAYS.min,
    withParams({ min: REVIEW_EVERY_DAYS.min, max: REVIEW_EVERY_DAYS.max }),
  )
  @Max(
    REVIEW_EVERY_DAYS.max,
    withParams({ min: REVIEW_EVERY_DAYS.min, max: REVIEW_EVERY_DAYS.max }),
  )
  reviewEveryDays?: number;
}

export class DanglingFindingsQueryDto {
  @ApiPropertyOptional({
    enum: FINDING_STATUSES,
    enumName: 'DanglingFindingStatus',
    description: 'Default: all.',
  })
  @IsOptional()
  @IsIn(FINDING_STATUSES)
  status?: (typeof FINDING_STATUSES)[number];
}

export class KeepDanglingAccountDto {
  @ApiProperty({
    type: String,
    description: 'From `danglingKeep`; the account is muted for 90 days.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

const DECISIONS = ['keep', 'revoke'] as const;

export class DecideAccessReviewLineDto {
  @ApiProperty({
    enum: DECISIONS,
    enumName: 'AccessReviewDecision',
    description:
      '`revoke` deactivates the account in the same transaction; the manager’s line is kept only.',
  })
  @IsIn(DECISIONS)
  decision: (typeof DECISIONS)[number];
}
