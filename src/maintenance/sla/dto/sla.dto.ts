import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsOptional,
  Max,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import { RESOLUTION_MINUTES, RESPONSE_MINUTES } from '../sla-targets.service';

const response = withParams({ ...RESPONSE_MINUTES });
const resolution = withParams({ ...RESOLUTION_MINUTES });

export class UpdateSlaSettingsDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Measure response and resolution times. Off until the manager turns it on; turning it on starts clocks for the open tickets from that moment, never earlier.',
  })
  @IsOptional()
  @IsBoolean()
  slaEnabled?: boolean;
}

const AT_RISK = { min: 50, max: 95 };

/** ADR 0076: the at-risk share (%) per priority; `null` for no warning. */
export class UpdateSlaEscalationDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    minimum: AT_RISK.min,
    maximum: AT_RISK.max,
    description:
      'At this share of its target a normal ticket’s running clock is at risk: its technician and the dispatch are told once. `null`: no warning.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt(withParams(AT_RISK))
  @Min(AT_RISK.min, withParams(AT_RISK))
  @Max(AT_RISK.max, withParams(AT_RISK))
  normal?: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    minimum: AT_RISK.min,
    maximum: AT_RISK.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt(withParams(AT_RISK))
  @Min(AT_RISK.min, withParams(AT_RISK))
  @Max(AT_RISK.max, withParams(AT_RISK))
  urgent?: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    minimum: AT_RISK.min,
    maximum: AT_RISK.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt(withParams(AT_RISK))
  @Min(AT_RISK.min, withParams(AT_RISK))
  @Max(AT_RISK.max, withParams(AT_RISK))
  emergency?: number | null;
}

export class SlaTargetDto {
  @ApiProperty({
    type: Number,
    minimum: RESPONSE_MINUTES.min,
    maximum: RESPONSE_MINUTES.max,
    description:
      'Minutes from opening to the first visit proposal or the start of the work.',
  })
  @IsInt(response)
  @Min(RESPONSE_MINUTES.min, response)
  @Max(RESPONSE_MINUTES.max, response)
  responseMinutes: number;

  @ApiProperty({
    type: Number,
    minimum: RESOLUTION_MINUTES.min,
    maximum: RESOLUTION_MINUTES.max,
    description:
      'Minutes from opening until the technician reports the work done, without the time spent waiting for the resident or for parts. At least the response target.',
  })
  @IsInt(resolution)
  @Min(RESOLUTION_MINUTES.min, resolution)
  @Max(RESOLUTION_MINUTES.max, resolution)
  resolutionMinutes: number;
}

/** A category's three targets, one per priority: the whole set. */
export class SlaTargetsDto {
  @ApiProperty({ type: SlaTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SlaTargetDto)
  emergency: SlaTargetDto;

  @ApiProperty({ type: SlaTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SlaTargetDto)
  urgent: SlaTargetDto;

  @ApiProperty({ type: SlaTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SlaTargetDto)
  normal: SlaTargetDto;
}

/** ADR 0076: a period of the compound's days, at most 366. */
export class SlaReportQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Clocks ended on or after, the compound’s day.',
  })
  @IsString()
  @IsLocalDate()
  from: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Ended on or before; at most 366 days after `from`.',
  })
  @IsString()
  @IsLocalDate()
  to: string;
}
