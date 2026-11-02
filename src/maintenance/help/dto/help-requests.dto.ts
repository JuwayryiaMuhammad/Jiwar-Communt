import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { HELP_KINDS, HELP_STATUSES } from '../views/help-request.views';

export class RequestHelpDto {
  @ApiProperty({ enum: HELP_KINDS, enumName: 'TechnicianHelpKind' })
  @IsIn(HELP_KINDS)
  kind: (typeof HELP_KINDS)[number];

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'One of the caller’s own tickets (assigned to them); otherwise TICKET_NOT_FOUND.',
  })
  @IsOptional()
  @IsUUID()
  ticketId?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 500,
    description: 'Their own words, for the field team and the helper only.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  note?: string;
}

export class TakeHelpDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'Another active technician to send (GUARD_NOT_ELIGIBLE otherwise); absent to handle it without one.',
  })
  @IsOptional()
  @IsUUID()
  helperId?: string;
}

export class HelpRequestsQueryDto {
  @ApiPropertyOptional({
    enum: HELP_STATUSES,
    enumName: 'TechnicianHelpStatus',
    description: 'Default: all.',
  })
  @IsOptional()
  @IsIn(HELP_STATUSES)
  status?: (typeof HELP_STATUSES)[number];
}
