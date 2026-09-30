import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../common/validation/validation-errors';
import { MAX_HOUSEHOLD_MEMBERS } from '../tenant-settings.service';

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
}
