import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { RosterRangeQueryDto } from '../../roster/dto/roster.dto';

const LABEL = { min: 1, max: 120 };
const POSITION = { min: 0, max: 1000 };

export class CreateHandoverItemDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @IsString()
  @Length(LABEL.min, LABEL.max, withParams(LABEL))
  label: string;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 1000, default: 0 })
  @IsOptional()
  @IsInt(withParams(POSITION))
  @Min(POSITION.min, withParams(POSITION))
  @Max(POSITION.max, withParams(POSITION))
  position?: number;
}

export class UpdateHandoverItemDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(LABEL.min, LABEL.max, withParams(LABEL))
  label?: string;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt(withParams(POSITION))
  @Min(POSITION.min, withParams(POSITION))
  @Max(POSITION.max, withParams(POSITION))
  position?: number;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'False retires it; true brings it back.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class StaffHandoversQueryDto extends RosterRangeQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({ enum: ['pending', 'acknowledged'] })
  @IsOptional()
  @IsIn(['pending', 'acknowledged'])
  @Type(() => String)
  state?: 'pending' | 'acknowledged';
}
