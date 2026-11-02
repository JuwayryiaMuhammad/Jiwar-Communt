import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ACTION_TEXT } from '../incident-actions.service';

export class CreateIncidentActionDto {
  @ApiProperty({
    type: String,
    minLength: ACTION_TEXT.min,
    maxLength: ACTION_TEXT.max,
    description: 'What must be done, about the work.',
  })
  @IsString()
  @Length(ACTION_TEXT.min, ACTION_TEXT.max, withParams({ ...ACTION_TEXT }))
  description: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active staff member or the manager. Told.',
  })
  @IsUUID()
  ownerId: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'From today, a year ahead at most.',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;
}

export class UpdateIncidentActionDto {
  @ApiPropertyOptional({
    type: String,
    minLength: ACTION_TEXT.min,
    maxLength: ACTION_TEXT.max,
  })
  @IsOptional()
  @IsString()
  @Length(ACTION_TEXT.min, ACTION_TEXT.max, withParams({ ...ACTION_TEXT }))
  description?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A new owner is told.',
  })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ type: String, format: 'date' })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  dueOn?: string;
}

export class IncidentActionDoneDto {
  @ApiPropertyOptional({
    type: String,
    minLength: ACTION_TEXT.min,
    maxLength: ACTION_TEXT.max,
    description: 'What was done, in the doer’s own words.',
  })
  @IsOptional()
  @IsString()
  @Length(ACTION_TEXT.min, ACTION_TEXT.max, withParams({ ...ACTION_TEXT }))
  note?: string;
}

export class CancelIncidentActionDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `incidentActionCancel`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
