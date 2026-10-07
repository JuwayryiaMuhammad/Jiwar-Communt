import { ApiProperty } from '@nestjs/swagger';
import {
  TicketAttachmentKind,
  TicketHoldReason,
  TicketPriority,
  TicketStatus,
} from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  COMMON_AREA_LENGTH,
  COMMENT_LENGTH,
  DESCRIPTION_LENGTH,
  MESSAGE_LENGTH,
} from '../ticket-limits';

const PRIORITIES = withParams({ allowed: Object.values(TicketPriority) });
const STATUSES = withParams({ allowed: Object.values(TicketStatus) });
const BOOL = ['true', 'false'] as const;

/** Where and what: a unit or a common area, never both (ADR 0032). */
class TicketBodyDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The unit; or `commonArea` instead.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: COMMON_AREA_LENGTH.min,
    maxLength: COMMON_AREA_LENGTH.max,
    description:
      'A short label for a common area (a corridor, the pool), instead of `unitId`.',
  })
  @IsOptional()
  @IsString()
  @Length(
    COMMON_AREA_LENGTH.min,
    COMMON_AREA_LENGTH.max,
    withParams(COMMON_AREA_LENGTH),
  )
  commonArea?: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  categoryId: string;

  @ApiProperty({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    required: false,
    description: "The category's default when absent.",
  })
  @IsOptional()
  @IsEnum(TicketPriority, PRIORITIES)
  priority?: TicketPriority;

  @ApiProperty({
    type: String,
    minLength: DESCRIPTION_LENGTH.min,
    maxLength: DESCRIPTION_LENGTH.max,
  })
  @IsString()
  @Length(
    DESCRIPTION_LENGTH.min,
    DESCRIPTION_LENGTH.max,
    withParams(DESCRIPTION_LENGTH),
  )
  description: string;
}

export class CreateTicketDto extends TicketBodyDto {
  @ApiProperty({
    type: [String],
    required: false,
    description:
      "Finalized `ticket_photo` files of the caller's; they move to the ticket. At most the compound's `maxReportPhotos`.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, withParams({ max: 10 }))
  @IsUUID('all', { each: true })
  photoFileIds?: string[];
}

/** Dispatch opens a ticket for a resident (ADR 0032). */
export class CreateTicketOnBehalfDto extends TicketBodyDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'Whose problem it is: a resident or family member who may open tickets there.',
  })
  @IsUUID()
  reporterAccountId: string;
}

export class ResidentTicketsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: TicketStatus,
    enumName: 'TicketStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(TicketStatus, STATUSES)
  status?: TicketStatus;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class TechnicianTicketsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: TicketStatus,
    enumName: 'TicketStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(TicketStatus, STATUSES)
  status?: TicketStatus;
}

export class DispatchTicketsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: TicketStatus,
    enumName: 'TicketStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(TicketStatus, STATUSES)
  status?: TicketStatus;

  @ApiProperty({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    required: false,
  })
  @IsOptional()
  @IsEnum(TicketPriority, PRIORITIES)
  priority?: TicketPriority;

  @ApiProperty({
    required: false,
    enum: BOOL,
    description: '`true`: only tickets without a technician.',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  unassigned?: (typeof BOOL)[number];

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  technicianId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class TicketPhotoDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      "A finalized `ticket_photo` of the caller's; it moves to the ticket.",
  })
  @IsUUID()
  fileId: string;
}

export class WorkPhotoDto extends TicketPhotoDto {
  @ApiProperty({ enum: ['before', 'after'] })
  @IsIn(['before', 'after'], withParams({ allowed: ['before', 'after'] }))
  kind: Exclude<TicketAttachmentKind, 'report'>;
}

/** A code from a closed list, and nothing else. */
export class ReasonCodeDto {
  @ApiProperty({
    type: String,
    description:
      'A code from the closed list for this action; see `allowed` on INVALID_REASON_CODE.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class AssignDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  technicianId: string;
}

export class ReassignDto extends AssignDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `ticketReassign`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class PriorityDto {
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  @IsEnum(TicketPriority, PRIORITIES)
  priority: TicketPriority;

  @ApiProperty({
    type: String,
    description: 'From the closed list `ticketPriority`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class CategoryChangeDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'An active category of the compound; for a common area, one that allows it.',
  })
  @IsUUID()
  categoryId: string;

  @ApiProperty({
    type: String,
    description: 'From the closed list `ticketCategory`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class HoldDto {
  @ApiProperty({ enum: TicketHoldReason, enumName: 'TicketHoldReason' })
  @IsEnum(
    TicketHoldReason,
    withParams({ allowed: Object.values(TicketHoldReason) }),
  )
  holdReason: TicketHoldReason;
}

export class ConfirmDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 5,
    description: 'The service.',
  })
  @IsInt(withParams({ min: 1, max: 5 }))
  @Min(1, withParams({ min: 1, max: 5 }))
  @Max(5, withParams({ min: 1, max: 5 }))
  rating: number;

  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 5,
    required: false,
    description:
      'The technician who did the work (ADR 0038); optional. Dispatch only.',
  })
  @IsOptional()
  @IsInt(withParams({ min: 1, max: 5 }))
  @Min(1, withParams({ min: 1, max: 5 }))
  @Max(5, withParams({ min: 1, max: 5 }))
  technicianRating?: number;

  @ApiProperty({
    type: String,
    required: false,
    minLength: COMMENT_LENGTH.min,
    maxLength: COMMENT_LENGTH.max,
    description: 'For the maintenance team. Never in the audit trail.',
  })
  @IsOptional()
  @IsString()
  @Length(COMMENT_LENGTH.min, COMMENT_LENGTH.max, withParams(COMMENT_LENGTH))
  comment?: string;
}

export class MessageDto {
  @ApiProperty({
    type: String,
    minLength: MESSAGE_LENGTH.min,
    maxLength: MESSAGE_LENGTH.max,
  })
  @IsString()
  @Length(MESSAGE_LENGTH.min, MESSAGE_LENGTH.max, withParams(MESSAGE_LENGTH))
  body: string;
}

/** Staff may write for staff only. */
export class StaffMessageDto extends MessageDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    default: false,
    description: 'Staff only: never shown to residents.',
  })
  @IsOptional()
  @IsBoolean()
  internal?: boolean;
}
