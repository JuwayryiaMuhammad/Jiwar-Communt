import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

export class CreateUnitDto {
  /** Unit code, unique within the compound, e.g. `B2-104`. */
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  code: string;

  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  building?: string;

  @IsOptional()
  @IsInt()
  @Min(-5, withParams({ min: -5, max: 200 }))
  @Max(200, withParams({ min: -5, max: 200 }))
  floor?: number;
}
