import { ApiProperty } from '@nestjs/swagger';
import { GateDirection, GateSubjectType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

export class VerifyDto {
  @ApiProperty({
    type: String,
    description: '6 digits (a visitor pass) or 8 (a worker).',
  })
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  code: string;
}

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
    type: String,
    format: 'date-time',
    required: false,
    description: 'When it happened (offline guards): up to 24 h back.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  occurredAt?: Date;
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
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
