import { ApiProperty } from '@nestjs/swagger';
import { OccupancyType } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

/** Where a unit stands (ADR 0072): closed-unit mode first, then anyone's place in it. */
export const UNIT_STATES = ['vacant', 'occupied', 'closed'] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/** The register's filters; `status` and `occupancyType` are the manager's (units.manage). */
export class UnitFiltersDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: 32,
    description: 'Part of the code, any case.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  q?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiProperty({
    enum: UNIT_STATES,
    required: false,
    description:
      '`closed`: in closed-unit mode; `occupied`: not closed, someone holds a place; `vacant`: not closed, nobody does. With `units.manage` only.',
  })
  @IsOptional()
  @IsIn(UNIT_STATES, withParams({ allowed: [...UNIT_STATES] }))
  status?: UnitState;

  @ApiProperty({
    enum: OccupancyType,
    enumName: 'OccupancyType',
    required: false,
    description:
      'Units someone holds a place in as this. With `units.manage` only.',
  })
  @IsOptional()
  @IsEnum(OccupancyType, withParams({ allowed: Object.values(OccupancyType) }))
  occupancyType?: OccupancyType;
}

/** `GET /units`: the page and the register's filters. */
export class UnitsQueryDto extends PageQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: 32,
    description: 'Part of the code, any case.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  q?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiProperty({
    enum: UNIT_STATES,
    required: false,
    description:
      '`closed`: in closed-unit mode; `occupied`: not closed, someone holds a place; `vacant`: not closed, nobody does. With `units.manage` only.',
  })
  @IsOptional()
  @IsIn(UNIT_STATES, withParams({ allowed: [...UNIT_STATES] }))
  status?: UnitState;

  @ApiProperty({
    enum: OccupancyType,
    enumName: 'OccupancyType',
    required: false,
    description:
      'Units someone holds a place in as this. With `units.manage` only.',
  })
  @IsOptional()
  @IsEnum(OccupancyType, withParams({ allowed: Object.values(OccupancyType) }))
  occupancyType?: OccupancyType;
}
