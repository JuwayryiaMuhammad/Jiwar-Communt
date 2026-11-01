import { ApiProperty } from '@nestjs/swagger';
import { UnitType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { AREA } from './update-unit.dto';

export class CreateUnitDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 32,
    description: 'Unit code, unique within the compound, e.g. `B2-104`.',
  })
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  code: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: 64,
    description:
      'A building by its name: the compound’s building of exactly that name, a new one if none (ADR 0072). Not with `buildingId`.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  building?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'One of the compound’s buildings (ADR 0072).',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string;

  @ApiProperty({ type: Number, required: false, minimum: -5, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(-5, withParams({ min: -5, max: 200 }))
  @Max(200, withParams({ min: -5, max: 200 }))
  floor?: number;

  @ApiProperty({ enum: UnitType, enumName: 'UnitType', required: false })
  @IsOptional()
  @IsEnum(UnitType, withParams({ allowed: Object.values(UnitType) }))
  unitType?: UnitType;

  @ApiProperty({
    type: String,
    required: false,
    example: '120.50',
    description: 'Square metres, above zero, up to 2 decimals.',
  })
  @IsOptional()
  @Matches(AREA)
  areaSqm?: string;
}
