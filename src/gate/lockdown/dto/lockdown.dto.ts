import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { END_NOTE } from '../lockdown.service';

const SCOPES = ['gate', 'all'] as const;
/** What the guard types to confirm (product decision: typed, immediate). */
export const LOCKDOWN_CONFIRMATION = 'LOCKDOWN';

export class StartLockdownDto {
  @ApiProperty({
    enum: SCOPES,
    description: '`gate`: one gate (`gateId`); `all`: every gate.',
  })
  @IsIn(SCOPES, withParams({ allowed: [...SCOPES] }))
  scope: (typeof SCOPES)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The gate, for `scope: gate`; never with `all`.',
  })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiProperty({
    type: String,
    description: 'From the closed list `gateLockdownStart`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    enum: [LOCKDOWN_CONFIRMATION],
    description:
      'The confirmation the guard types: exactly `LOCKDOWN`. Nothing starts without it.',
  })
  @IsIn(
    [LOCKDOWN_CONFIRMATION],
    withParams({ allowed: [LOCKDOWN_CONFIRMATION] }),
  )
  confirmation: typeof LOCKDOWN_CONFIRMATION;
}

export class LockdownOverrideDto {
  @ApiProperty({
    type: String,
    description:
      'What came through, from the closed list `gateLockdownOverride`: ambulance, fire_truck, police, civil_defense.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The emergency it answers, when there is one.',
  })
  @IsOptional()
  @IsUUID()
  emergencyId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The lane a resident asked for (ADR 0047), when there is one.',
  })
  @IsOptional()
  @IsUUID()
  gateServiceRequestId?: string;
}

export class EndLockdownDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `gateLockdownEnd`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: END_NOTE.min,
    maxLength: END_NOTE.max,
    description: 'The management’s own words; nobody else reads them.',
  })
  @IsOptional()
  @IsString()
  @Length(END_NOTE.min, END_NOTE.max, withParams({ ...END_NOTE }))
  note?: string;
}

const STATES = ['live', 'ended'] as const;

export class StaffLockdownsQueryDto extends PageQueryDto {
  @ApiProperty({ enum: STATES, required: false })
  @IsOptional()
  @IsIn(STATES, withParams({ allowed: [...STATES] }))
  status?: (typeof STATES)[number];
}
