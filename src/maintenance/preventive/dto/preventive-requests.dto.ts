import { ApiProperty } from '@nestjs/swagger';
import { TicketUnitLocation } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { DESCRIPTION_LENGTH } from '../../tickets/ticket-limits';
import {
  VisitSlotsQueryDto,
  VisitWindowDto,
} from '../../visits/dto/visits.dto';

/**
 * A check-up, booked (ADR 0038). The window is checked against the
 * database's clock like a visit's, and must lie inside the compound's
 * visiting hours on one day.
 */
export class CreatePreventiveRequestDto extends VisitWindowDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'From `GET /preventive-services`.',
  })
  @IsUUID()
  serviceId: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: DESCRIPTION_LENGTH.min,
    maxLength: DESCRIPTION_LENGTH.max,
    description: 'Optional; it becomes the ticket’s `description`.',
  })
  @IsOptional()
  @IsString()
  @Length(
    DESCRIPTION_LENGTH.min,
    DESCRIPTION_LENGTH.max,
    withParams(DESCRIPTION_LENGTH),
  )
  note?: string;

  @ApiProperty({
    enum: TicketUnitLocation,
    enumName: 'TicketUnitLocation',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    TicketUnitLocation,
    withParams({ allowed: Object.values(TicketUnitLocation) }),
  )
  unitLocation?: TicketUnitLocation;
}

/** Which days to offer booking slots for, on which unit. */
export class PreventiveSlotsQueryDto extends VisitSlotsQueryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;
}
