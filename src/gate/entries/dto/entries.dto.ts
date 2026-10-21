import { ApiProperty } from '@nestjs/swagger';
import { GateDirection, GateSubjectType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ExclusiveWith } from '../../../core/common/validation/exclusive-with';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ToInstant } from '../../../core/common/validation/instant';

/** Exactly one of `code` (typed) or `qr` (scanned), ADR 0030. */
export class VerifyDto {
  @ApiProperty({
    type: String,
    required: false,
    description: '6 digits (a visitor pass) or 8 (a worker). Or send `qr`.',
  })
  @ValidateIf((o: VerifyDto) => o.qr === undefined || o.code !== undefined)
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  code?: string;

  @ApiProperty({
    type: String,
    required: false,
    example: 'JWR1.q3Jz…',
    description:
      "A scanned Jiwar QR: `JWR1.<token>` (a pass or a worker's card) or `JWR2.<credentialId>.<step>.<mac>` (a resident's rotating QR, ADR 0031). Anything else answers like an unknown code.",
  })
  @IsOptional()
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  @ExclusiveWith('code')
  qr?: string;
}

/** How a guard identified who came in (ADR 0030). */
export const ENTRY_VIA = ['code', 'qr'] as const;
export type EntryVia = (typeof ENTRY_VIA)[number];

export class RecordEntryDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'Client-generated (UUIDv7): a retry with the same id records once.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ enum: GateSubjectType, enumName: 'GateSubjectType' })
  @IsEnum(
    GateSubjectType,
    withParams({ allowed: Object.values(GateSubjectType) }),
  )
  subjectType: GateSubjectType;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  subjectId: string;

  @ApiProperty({ enum: GateDirection, enumName: 'GateDirection' })
  @IsEnum(GateDirection, withParams({ allowed: Object.values(GateDirection) }))
  direction: GateDirection;

  @ApiProperty({
    enum: ENTRY_VIA,
    required: false,
    default: 'code',
    description:
      'An entry on a pass or a worker code: typed or scanned. Exits and approvals keep their own method.',
  })
  @IsOptional()
  @IsIn(ENTRY_VIA, withParams({ allowed: [...ENTRY_VIA] }))
  via?: EntryVia;

  @ApiProperty({
    type: String,
    required: false,
    example: '4821',
    description:
      'A contractor worker’s `in` (`permit_worker`, ADR 0049): the last four characters of the ID they show, typed by the guard after matching their face. Required, offline too (FIELD_REQUIRED). A wrong one is refused (`id_mismatch`); five in 15 minutes lock the guard out, ten in a day the worker (PERMIT_ID_LOCKED). Never stored, never shown.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9]{4}$/)
  idLast4?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'When it happened (offline guards): up to 24 h back.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  occurredAt?: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A visitor’s `in` only (a pass, a gate request, a field exception’s; ADR 0056): the guard’s photo of them, uploaded first as `visitor_photo`. Seen by the guards on shift and the management, never the household; deleted 30 days after the entry unless an incident keeps it.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class EntriesQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    enum: GateSubjectType,
    enumName: 'GateSubjectType',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    GateSubjectType,
    withParams({ allowed: Object.values(GateSubjectType) }),
  )
  subjectType?: GateSubjectType;

  @ApiProperty({
    enum: GateDirection,
    enumName: 'GateDirection',
    required: false,
  })
  @IsOptional()
  @IsEnum(GateDirection, withParams({ allowed: Object.values(GateDirection) }))
  direction?: GateDirection;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @ToInstant()
  @IsDate()
  from?: Date;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @ToInstant()
  @IsDate()
  to?: Date;
}
