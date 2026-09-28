import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateUnitDto {
  /** Unit code, unique within the compound, e.g. `B2-104`. */
  @IsString()
  @Length(1, 32)
  code: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  building?: string;

  @IsOptional()
  @IsInt()
  @Min(-5)
  @Max(200)
  floor?: number;
}
