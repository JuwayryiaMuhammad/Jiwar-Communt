import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

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

  @ApiProperty({ type: String, required: false, minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  building?: string;

  @ApiProperty({ type: Number, required: false, minimum: -5, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(-5, withParams({ min: -5, max: 200 }))
  @Max(200, withParams({ min: -5, max: 200 }))
  floor?: number;
}
