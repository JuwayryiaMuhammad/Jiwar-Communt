import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PostDto } from '../../roster/dto/roster.dto';
import {
  CHECKPOINT_NAME,
  DEFAULT_RADIUS_M,
  LATITUDE,
  LONGITUDE,
  RADIUS_M,
} from '../patrol-rules';

const name = withParams({ ...CHECKPOINT_NAME });
const decimals = { maxDecimalPlaces: 7 };

/** Where a checkpoint is, and how near a scan should be (ADR 0052). */
export class CheckpointPositionDto {
  @ApiProperty({ type: Number, minimum: LATITUDE.min, maximum: LATITUDE.max })
  @IsNumber(decimals, withParams({ ...LATITUDE }))
  @Min(LATITUDE.min, withParams({ ...LATITUDE }))
  @Max(LATITUDE.max, withParams({ ...LATITUDE }))
  lat: number;

  @ApiProperty({
    type: Number,
    minimum: LONGITUDE.min,
    maximum: LONGITUDE.max,
  })
  @IsNumber(decimals, withParams({ ...LONGITUDE }))
  @Min(LONGITUDE.min, withParams({ ...LONGITUDE }))
  @Max(LONGITUDE.max, withParams({ ...LONGITUDE }))
  lng: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: RADIUS_M.min,
    maximum: RADIUS_M.max,
    description: `Metres; ${DEFAULT_RADIUS_M} by default. A scan farther away is accepted and flagged.`,
  })
  @IsOptional()
  @IsInt(withParams({ ...RADIUS_M }))
  @Min(RADIUS_M.min, withParams({ ...RADIUS_M }))
  @Max(RADIUS_M.max, withParams({ ...RADIUS_M }))
  radiusM?: number;
}

export class CreateCheckpointDto extends PostDto {
  @ApiProperty({
    type: String,
    minLength: CHECKPOINT_NAME.min,
    maxLength: CHECKPOINT_NAME.max,
    example: 'Pool gate',
  })
  @IsString()
  @Length(CHECKPOINT_NAME.min, CHECKPOINT_NAME.max, name)
  nameEn: string;

  @ApiProperty({
    type: String,
    minLength: CHECKPOINT_NAME.min,
    maxLength: CHECKPOINT_NAME.max,
    example: 'بوابة المسبح',
  })
  @IsString()
  @Length(CHECKPOINT_NAME.min, CHECKPOINT_NAME.max, name)
  nameAr: string;

  @ApiPropertyOptional({ type: CheckpointPositionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckpointPositionDto)
  position?: CheckpointPositionDto;
}

export class UpdateCheckpointDto {
  @ApiPropertyOptional({
    type: String,
    minLength: CHECKPOINT_NAME.min,
    maxLength: CHECKPOINT_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(CHECKPOINT_NAME.min, CHECKPOINT_NAME.max, name)
  nameEn?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: CHECKPOINT_NAME.min,
    maxLength: CHECKPOINT_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(CHECKPOINT_NAME.min, CHECKPOINT_NAME.max, name)
  nameAr?: string;

  @ApiPropertyOptional({
    type: CheckpointPositionDto,
    nullable: true,
    description: 'Null removes the position; absent leaves it.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckpointPositionDto)
  position?: CheckpointPositionDto | null;
}

const STATUSES = ['active', 'retired'] as const;

export class CheckpointsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES, description: 'Both by default.' })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}
