import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const NAME = { min: 1, max: 80 };
export const TOPIC_KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** Up to thirty days. */
export const TARGET_RESPONSE_HOURS = { min: 1, max: 720 } as const;

export class CreateTopicDto {
  @ApiProperty({
    type: String,
    pattern: TOPIC_KEY.source,
    description:
      'Stable code, lowercase (e.g. `parking`). Never changes once created.',
  })
  @IsString()
  @Matches(TOPIC_KEY)
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
    type: Number,
    minimum: TARGET_RESPONSE_HOURS.min,
    maximum: TARGET_RESPONSE_HOURS.max,
    description: 'Hours the management gives itself to answer.',
  })
  @IsInt(withParams({ ...TARGET_RESPONSE_HOURS }))
  @Min(TARGET_RESPONSE_HOURS.min, withParams({ ...TARGET_RESPONSE_HOURS }))
  @Max(TARGET_RESPONSE_HOURS.max, withParams({ ...TARGET_RESPONSE_HOURS }))
  targetResponseHours: number;
}

export class UpdateTopicDto {
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
    type: Number,
    required: false,
    minimum: TARGET_RESPONSE_HOURS.min,
    maximum: TARGET_RESPONSE_HOURS.max,
    description:
      'Applies to requests opened or reopened from now on; a running cycle keeps its due time.',
  })
  @IsOptional()
  @IsInt(withParams({ ...TARGET_RESPONSE_HOURS }))
  @Min(TARGET_RESPONSE_HOURS.min, withParams({ ...TARGET_RESPONSE_HOURS }))
  @Max(TARGET_RESPONSE_HOURS.max, withParams({ ...TARGET_RESPONSE_HOURS }))
  targetResponseHours?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False retires the topic: no new request may use it.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
    description:
      'The staff role that owns the topic (ADR 0058): residents see its name, and an unassigned request goes to its handlers. Null: every handler. A role of a resident kind is TOPIC_OWNER_NOT_STAFF.',
  })
  @IsOptional()
  @ValidateIf((o: UpdateTopicDto) => o.ownerRoleId !== null)
  @IsUUID()
  ownerRoleId?: string | null;
}
