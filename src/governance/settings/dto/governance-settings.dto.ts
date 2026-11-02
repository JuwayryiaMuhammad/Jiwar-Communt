import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { LARGE_AMOUNT } from '../../../core/common/amounts';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  DEADLINE_DAYS,
  SETTING_TYPES,
  type SettingType,
} from '../../approvals/approval-rules';

export class GovernanceSettingDto {
  @ApiProperty({ enum: SETTING_TYPES, enumName: 'GovernanceSettingType' })
  @IsIn(SETTING_TYPES, withParams({ allowed: [...SETTING_TYPES] }))
  type: SettingType;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: DEADLINE_DAYS.min,
    maximum: DEADLINE_DAYS.max,
    description:
      'Days the board has to decide a matter of this type raised from now on.',
  })
  @IsOptional()
  @IsInt(withParams(DEADLINE_DAYS))
  @Min(DEADLINE_DAYS.min, withParams(DEADLINE_DAYS))
  @Max(DEADLINE_DAYS.max, withParams(DEADLINE_DAYS))
  deadlineDays?: number;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    pattern: LARGE_AMOUNT.source,
    description:
      'EGP; null to clear. The four thresholded types only (FIELD_NOT_ALLOWED otherwise). major_contract’s is the manager’s limit for one expense.',
  })
  @IsOptional()
  @IsString()
  @Matches(LARGE_AMOUNT)
  threshold?: string | null;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Whether the threshold binds (ADR 0073): above it, finance refuses the credit or the plan unless the board approved it. waiver_above_limit, payment_plan_above_limit and compensation_above_limit (ADR 0082, binding by default) only (FIELD_NOT_ALLOWED otherwise); major_contract’s always binds.',
  })
  @IsOptional()
  @IsBoolean()
  binding?: boolean;
}

/** One PATCH may send every type, once each (the service refuses a repeat). */
const ITEMS = { min: 1, max: SETTING_TYPES.length };

/** Changes some types' rows; the others stay. */
export class UpdateGovernanceSettingsDto {
  @ApiProperty({
    type: [GovernanceSettingDto],
    minItems: ITEMS.min,
    maxItems: ITEMS.max,
  })
  @IsArray()
  @ArrayMinSize(ITEMS.min, withParams(ITEMS))
  @ArrayMaxSize(ITEMS.max, withParams(ITEMS))
  @ValidateNested({ each: true })
  @Type(() => GovernanceSettingDto)
  items: GovernanceSettingDto[];
}
