import { ApiProperty } from '@nestjs/swagger';
import { UnitType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

/** Square metres, up to six digits and two decimals, above zero. */
export const AREA = /^\d{1,6}(\.\d{1,2})?$/;

/** What the manager may change of a unit (ADR 0072); never its code. Null clears. */
export class UpdateUnitDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description: 'One of the compound’s buildings; null: none.',
  })
  @IsOptional()
  @IsUUID()
  buildingId?: string | null;

  @ApiProperty({
    type: Number,
    required: false,
    nullable: true,
    minimum: -5,
    maximum: 200,
  })
  @IsOptional()
  @IsInt()
  @Min(-5, withParams({ min: -5, max: 200 }))
  @Max(200, withParams({ min: -5, max: 200 }))
  floor?: number | null;

  @ApiProperty({
    enum: UnitType,
    enumName: 'UnitType',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsEnum(UnitType, withParams({ allowed: Object.values(UnitType) }))
  unitType?: UnitType | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: '120.50',
    description: 'Square metres, above zero, up to 2 decimals.',
  })
  @IsOptional()
  @Matches(AREA)
  areaSqm?: string | null;
}
