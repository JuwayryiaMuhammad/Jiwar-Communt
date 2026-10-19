import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { GEOFENCE_RADIUS_M, GEOFENCE_VERTICES } from '../geofence';
import {
  CHECKPOINT_NAME,
  EXPECTED_MINUTES,
  LATITUDE,
  LONGITUDE,
  ROUTE_CHECKPOINTS,
  TIMES_PER_DAY,
} from '../patrol-rules';

const name = withParams({ ...CHECKPOINT_NAME });

export class PatrolScheduleDto {
  @ApiProperty({
    type: [Number],
    example: [0, 1, 2, 3, 4],
    description: '0 = Sunday … 6 = Saturday.',
  })
  @IsArray()
  @IsInt({ each: true })
  days: number[];

  @ApiProperty({
    type: [String],
    example: ['08:00', '14:00', '22:00'],
    minItems: TIMES_PER_DAY.min,
    maxItems: TIMES_PER_DAY.max,
    description:
      'Each a run’s start (`HH:MM`, the compound’s time). Two starts closer than a run’s window — its expected minutes, 30 at least — are refused (PATROL_SCHEDULE_OVERLAP), over midnight too.',
  })
  @IsArray()
  @IsString({ each: true })
  times: string[];
}

export class GeofenceCircleDto {
  @ApiProperty({ type: Number, minimum: LATITUDE.min, maximum: LATITUDE.max })
  @IsNumber({}, withParams({ ...LATITUDE }))
  @Min(LATITUDE.min, withParams({ ...LATITUDE }))
  @Max(LATITUDE.max, withParams({ ...LATITUDE }))
  lat: number;

  @ApiProperty({ type: Number, minimum: LONGITUDE.min, maximum: LONGITUDE.max })
  @IsNumber({}, withParams({ ...LONGITUDE }))
  @Min(LONGITUDE.min, withParams({ ...LONGITUDE }))
  @Max(LONGITUDE.max, withParams({ ...LONGITUDE }))
  lng: number;

  @ApiProperty({
    type: Number,
    minimum: GEOFENCE_RADIUS_M.min,
    maximum: GEOFENCE_RADIUS_M.max,
    description: 'Metres.',
  })
  @IsInt(withParams({ ...GEOFENCE_RADIUS_M }))
  @Min(GEOFENCE_RADIUS_M.min, withParams({ ...GEOFENCE_RADIUS_M }))
  @Max(GEOFENCE_RADIUS_M.max, withParams({ ...GEOFENCE_RADIUS_M }))
  radiusM: number;
}

/** Where a patrol of the route stays (ADR 0056): one of the two. */
export class GeofenceDto {
  @ApiPropertyOptional({ type: GeofenceCircleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeofenceCircleDto)
  circle?: GeofenceCircleDto;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
    },
    minItems: GEOFENCE_VERTICES.min,
    maxItems: GEOFENCE_VERTICES.max,
    example: [
      [30.0, 31.0],
      [30.0, 31.0023],
      [30.002, 31.0023],
      [30.002, 31.0],
    ],
    description:
      '`[lat, lng]` vertices in order, not closed (the last joins the first). Edges may not cross, and it must enclose an area (INVALID_VALUE).',
  })
  @IsOptional()
  @IsArray()
  polygon?: number[][];
}

/** What a route asks: one version of it. */
export class RouteVersionDto {
  @ApiProperty({
    type: [String],
    minItems: ROUTE_CHECKPOINTS.min,
    maxItems: ROUTE_CHECKPOINTS.max,
    description:
      'Checkpoints in service, in the order walked, each once (CHECKPOINT_NOT_AVAILABLE, DUPLICATE_VALUE).',
  })
  @IsArray()
  @ArrayMinSize(ROUTE_CHECKPOINTS.min, withParams({ ...ROUTE_CHECKPOINTS }))
  @ArrayMaxSize(ROUTE_CHECKPOINTS.max, withParams({ ...ROUTE_CHECKPOINTS }))
  @IsUUID(undefined, { each: true })
  checkpointIds: string[];

  @ApiProperty({
    type: Boolean,
    description: 'The guard must scan them in this order.',
  })
  @IsBoolean()
  ordered: boolean;

  @ApiProperty({
    type: Number,
    minimum: EXPECTED_MINUTES.min,
    maximum: EXPECTED_MINUTES.max,
  })
  @IsInt(withParams({ ...EXPECTED_MINUTES }))
  @Min(EXPECTED_MINUTES.min, withParams({ ...EXPECTED_MINUTES }))
  @Max(EXPECTED_MINUTES.max, withParams({ ...EXPECTED_MINUTES }))
  expectedMinutes: number;

  @ApiPropertyOptional({
    type: PatrolScheduleDto,
    nullable: true,
    description:
      'Weekly start times; none: only the runs a guard starts. Runs are made 7 days ahead.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PatrolScheduleDto)
  schedule?: PatrolScheduleDto | null;

  @ApiPropertyOptional({
    type: GeofenceDto,
    nullable: true,
    description:
      'Where a patrol of it stays (ADR 0056): a circle or a polygon. A guard outside it longer than the gate’s `geofenceExitMinutes` is flagged to `patrols.manage`, once per exit. None: not watched.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeofenceDto)
  geofence?: GeofenceDto | null;
}

export class CreateRouteDto extends PostDto {
  @ApiProperty({
    type: String,
    minLength: CHECKPOINT_NAME.min,
    maxLength: CHECKPOINT_NAME.max,
    example: 'Night perimeter',
  })
  @IsString()
  @Length(CHECKPOINT_NAME.min, CHECKPOINT_NAME.max, name)
  nameEn: string;

  @ApiProperty({
    type: String,
    minLength: CHECKPOINT_NAME.min,
    maxLength: CHECKPOINT_NAME.max,
    example: 'جولة السور الليلية',
  })
  @IsString()
  @Length(CHECKPOINT_NAME.min, CHECKPOINT_NAME.max, name)
  nameAr: string;

  @ApiProperty({ type: RouteVersionDto })
  @ValidateNested()
  @Type(() => RouteVersionDto)
  version: RouteVersionDto;
}

export class RenameRouteDto {
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
}

const STATUSES = ['active', 'retired'] as const;

export class RoutesQueryDto extends PageQueryDto {
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
