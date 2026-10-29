import { TICKET_ORIGINS, type TicketOrigin } from '../ticket-visibility';
import { ApiProperty } from '@nestjs/swagger';
import {
  TicketAttachmentKind,
  TicketHoldReason,
  TicketPriority,
  TicketStatus,
  TicketUnitLocation,
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
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  COMMON_AREA_LENGTH,
  COMMENT_LENGTH,
  DESCRIPTION_LENGTH,
  MESSAGE_LENGTH,
} from '../ticket-limits';

const PRIORITIES = withParams({ allowed: Object.values(TicketPriority) });
const STATUSES = withParams({ allowed: Object.values(TicketStatus) });
const UNIT_LOCATIONS = withParams({
  allowed: Object.values(TicketUnitLocation),
});
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

  @ApiProperty({
    enum: TicketUnitLocation,
    enumName: 'TicketUnitLocation',
    required: false,
    description: 'The room (ADR 0038); with `unitId` only.',
  })
  @IsOptional()
  @IsEnum(TicketUnitLocation, UNIT_LOCATIONS)
  unitLocation?: TicketUnitLocation;

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

const TECHNICIAN_SORTS = ['newest', 'priority'] as const;

export class TechnicianTicketsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: TicketStatus,
    enumName: 'TicketStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(TicketStatus, STATUSES)
  status?: TicketStatus;

  @ApiProperty({
    enum: TECHNICIAN_SORTS,
    required: false,
    default: 'newest',
    description:
      '`priority` (ADR 0064): emergencies first, then urgent, then normal; newest first within each. Its cursor is its own.',
  })
  @IsOptional()
  @IsIn(TECHNICIAN_SORTS, withParams({ allowed: [...TECHNICIAN_SORTS] }))
  sort?: (typeof TECHNICIAN_SORTS)[number];
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

  @ApiProperty({
    required: false,
    enum: TICKET_ORIGINS,
    enumName: 'TicketOrigin',
    description:
      'Only tickets of this origin (ADR 0064): `resident`, or a work order of the compound’s.',
  })
  @IsOptional()
  @IsIn(TICKET_ORIGINS, withParams({ allowed: [...TICKET_ORIGINS] }))
  origin?: TicketOrigin;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'Only the work orders of this asset.',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiProperty({
    required: false,
    enum: BOOL,
    description:
      '`true`: only tickets that are not finished: every status but `closed` and `cancelled`. Combines with `status` (both must hold).',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  open?: (typeof BOOL)[number];

  @ApiProperty({
    required: false,
    enum: BOOL,
    description:
      '`true`: only tickets whose `sla.overdue` is true (ADR 0034). None while the SLA is off.',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  overdue?: (typeof BOOL)[number];

  @ApiProperty({
    required: false,
    enum: BOOL,
    description:
      '`true`: only tickets with an `escalatedAt` (ADR 0038). None while the SLA is off.',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  escalated?: (typeof BOOL)[number];
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

/** What was done, as the technician completes (ADR 0065); optional. */
export class CompleteTicketDto {
  @ApiProperty({
    enum: REASON_CODES.ticketCompletionAction,
    required: false,
    description:
      'What was done (`ticketCompletionAction`); the resident sees it.',
  })
  @IsOptional()
  @IsIn(
    REASON_CODES.ticketCompletionAction,
    withParams({ allowed: [...REASON_CODES.ticketCompletionAction] }),
  )
  actionCode?: (typeof REASON_CODES.ticketCompletionAction)[number];

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 2000,
    description: 'For the staff only; needs `actionCode`.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 2000, withParams({ min: 1, max: 2000 }))
  note?: string;
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
