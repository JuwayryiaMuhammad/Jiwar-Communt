import { ApiProperty } from '@nestjs/swagger';
import { WorkerCapacity, WorkerEngagementStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { IdentityDocumentDto } from '../../../core/common/http/identity-document.dto';
import { PageQueryDto } from '../../../core/common/http/list';
import { ReasonDto } from '../../../core/common/http/reason.dto';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';

export const WORKER_LANGUAGES = ['ar', 'en'] as const;

export class WorkerWindowDto {
  @ApiProperty({ type: String, example: '08:00' })
  from: string;
  @ApiProperty({
    type: String,
    example: '14:00',
    description: 'Before `from`: an overnight window.',
  })
  to: string;
}

export class WorkerScheduleDto {
  @ApiProperty({ type: [Number], description: '0 (Sunday) … 6.' })
  days: number[];
  @ApiProperty({ type: [WorkerWindowDto] })
  windows: WorkerWindowDto[];
}

export class NewWorkerDto extends IdentityDocumentDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200, withParams({ min: 2, max: 200 }))
  fullName: string;

  @ApiProperty({ type: String })
  @IsPhone()
  phone: string;

  @ApiProperty({ enum: WorkerCapacity, enumName: 'WorkerCapacity' })
  @IsEnum(
    WorkerCapacity,
    withParams({ allowed: Object.values(WorkerCapacity) }),
  )
  capacity: WorkerCapacity;

  @ApiProperty({
    type: WorkerScheduleDto,
    required: false,
    description:
      'Checked by the service (INVALID_SCHEDULE); empty for live-in.',
  })
  @IsOptional()
  @IsObject()
  schedule?: WorkerScheduleDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'Required for `temporary`.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validUntil?: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A finalized `worker_photo` of the caller (ADR 0029); it moves to the worker. Used only when the worker has no photo yet.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;

  @ApiProperty({
    enum: WORKER_LANGUAGES,
    required: false,
    description:
      "The card's language (default `ar`). Kept by a worker already known to the compound.",
  })
  @IsOptional()
  @IsIn(WORKER_LANGUAGES, withParams({ allowed: [...WORKER_LANGUAGES] }))
  preferredLanguage?: (typeof WORKER_LANGUAGES)[number];
}

/** A manager sets or replaces a worker's photo (ADR 0029). */
export class WorkerPhotoDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: "A finalized `worker_photo` of the caller's.",
  })
  @IsUUID()
  fileId: string;
}

export class ReissueCodeDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `cardReissue`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

const DECISIONS = ['approve', 'reject'] as const;

/** A rejection needs a reason; a passport worker's birth date is attested once. */
export class ReviewDto extends ReasonDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS, withParams({ allowed: [...DECISIONS] }))
  decision: (typeof DECISIONS)[number];

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  birthDateConfirmed?: boolean;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'Corrects it at the same time.',
  })
  @IsOptional()
  @IsString()
  birthDate?: string;
}

export class BirthDateDto {
  @ApiProperty({ type: String, format: 'date' })
  @IsString()
  birthDate: string;
}

const INCIDENTS = ['lost', 'confiscated'] as const;

export class CardIncidentDto {
  @ApiProperty({ enum: INCIDENTS })
  @IsIn(INCIDENTS, withParams({ allowed: [...INCIDENTS] }))
  type: (typeof INCIDENTS)[number];

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 500,
    description: 'Never returned by the API (v0).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  note?: string;
}

export class EngagementsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: WorkerEngagementStatus,
    enumName: 'WorkerEngagementStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    WorkerEngagementStatus,
    withParams({ allowed: Object.values(WorkerEngagementStatus) }),
  )
  status?: WorkerEngagementStatus;
}

const OPEN_CLOSED = ['open', 'closed'] as const;

export class OpenClosedQueryDto extends PageQueryDto {
  @ApiProperty({ enum: OPEN_CLOSED, required: false })
  @IsOptional()
  @IsIn(OPEN_CLOSED, withParams({ allowed: [...OPEN_CLOSED] }))
  status?: (typeof OPEN_CLOSED)[number];
}
