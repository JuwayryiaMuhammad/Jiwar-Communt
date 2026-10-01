import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { IsPhone } from '../../common/validation/is-phone';
import { withParams } from '../../common/validation/validation-errors';
import {
  GATE_REQUEST_TIMEOUT_SECONDS,
  MAX_ACTIVE_VISITOR_PASSES,
  MAX_HOUSEHOLD_MEMBERS,
  VISITOR_DIRECTIONS_LENGTH,
} from '../tenant-settings.service';

export class UpdateSettingsDto {
  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  familyJoinRequiresApproval?: boolean;

  @ApiProperty({ type: Number, required: false, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt(withParams({ ...MAX_HOUSEHOLD_MEMBERS }))
  @Min(MAX_HOUSEHOLD_MEMBERS.min, withParams({ ...MAX_HOUSEHOLD_MEMBERS }))
  @Max(MAX_HOUSEHOLD_MEMBERS.max, withParams({ ...MAX_HOUSEHOLD_MEMBERS }))
  maxHouseholdMembers?: number;

  @ApiProperty({
    type: String,
    required: false,
    example: 'Africa/Cairo',
    description: 'IANA time zone.',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: MAX_ACTIVE_VISITOR_PASSES.min,
    maximum: MAX_ACTIVE_VISITOR_PASSES.max,
    description: 'Active visitor passes per unit.',
  })
  @IsOptional()
  @IsInt(withParams({ ...MAX_ACTIVE_VISITOR_PASSES }))
  @Min(
    MAX_ACTIVE_VISITOR_PASSES.min,
    withParams({ ...MAX_ACTIVE_VISITOR_PASSES }),
  )
  @Max(
    MAX_ACTIVE_VISITOR_PASSES.max,
    withParams({ ...MAX_ACTIVE_VISITOR_PASSES }),
  )
  maxActiveVisitorPasses?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: GATE_REQUEST_TIMEOUT_SECONDS.min,
    maximum: GATE_REQUEST_TIMEOUT_SECONDS.max,
    description:
      'Seconds a household has to answer the gate before its standing instruction applies.',
  })
  @IsOptional()
  @IsInt(withParams({ ...GATE_REQUEST_TIMEOUT_SECONDS }))
  @Min(
    GATE_REQUEST_TIMEOUT_SECONDS.min,
    withParams({ ...GATE_REQUEST_TIMEOUT_SECONDS }),
  )
  @Max(
    GATE_REQUEST_TIMEOUT_SECONDS.max,
    withParams({ ...GATE_REQUEST_TIMEOUT_SECONDS }),
  )
  gateRequestTimeoutSeconds?: number;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    maxLength: VISITOR_DIRECTIONS_LENGTH.max,
    description:
      'What the compound tells its visitors on the public pass page (ADR 0030). `null` clears it.',
  })
  @IsOptional()
  @IsString()
  @Length(
    VISITOR_DIRECTIONS_LENGTH.min,
    VISITOR_DIRECTIONS_LENGTH.max,
    withParams({ ...VISITOR_DIRECTIONS_LENGTH }),
  )
  visitorDirections?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: '+201000000000',
    description:
      'Stored in E.164; on the visitor page and the worker card. `null` clears it.',
  })
  @IsOptional()
  @IsPhone()
  emergencyPhone?: string | null;
}
