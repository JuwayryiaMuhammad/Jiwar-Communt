import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
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
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MAX_HOTSPOTS } from '../floor-plans.service';
import { MAP_POINT_KINDS, MAX_MAP_POINTS } from '../site-map.service';
import { SPACE_USE_RULES, SPACE_USE_STATUSES } from '../space-uses.service';

const FRACTION = withParams({ min: 0, max: 1 });

/** A fraction of the image's width or height: 0 to 1, five decimals kept. */
function Fraction(description: string): PropertyDecorator {
  return (target, property) => {
    const key = property as string;
    ApiProperty({ type: Number, minimum: 0, maximum: 1, description })(
      target,
      key,
    );
    IsNumber({ allowNaN: false, allowInfinity: false }, FRACTION)(target, key);
    Min(0, FRACTION)(target, key);
    Max(1, FRACTION)(target, key);
  };
}

export class ImageDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A finalized upload of the caller’s, of the purpose `site_map` or `floor_plan` (FILE_NOT_AVAILABLE).',
  })
  @IsUUID()
  fileId: string;
}

export class MapPointDto {
  @ApiProperty({ enum: MAP_POINT_KINDS })
  @IsIn(MAP_POINT_KINDS, withParams({ allowed: [...MAP_POINT_KINDS] }))
  kind: (typeof MAP_POINT_KINDS)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The building (ADR 0072), gate or active facility (MAP_PLACE_NOT_AVAILABLE); each once (DUPLICATE_VALUE).',
  })
  @IsUUID()
  refId: string;

  @Fraction('From the image’s left edge.')
  x: number;

  @Fraction('From the image’s top edge.')
  y: number;
}

export class SetMapPointsDto {
  @ApiProperty({
    type: [MapPointDto],
    description: `Every point of the map, replacing them all; at most ${MAX_MAP_POINTS}.`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_MAP_POINTS, withParams({ min: 0, max: MAX_MAP_POINTS }))
  @ValidateNested({ each: true })
  @Type(() => MapPointDto)
  points: MapPointDto[];
}

export class FloorPlansQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

export class CreateFloorPlanDto extends ImageDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A building of the register (BUILDING_NOT_FOUND).',
  })
  @IsUUID()
  buildingId: string;

  @ApiProperty({
    type: Number,
    minimum: -5,
    maximum: 200,
    description: 'One plan a floor (FLOOR_PLAN_EXISTS).',
  })
  @IsInt(withParams({ min: -5, max: 200 }))
  @Min(-5, withParams({ min: -5, max: 200 }))
  @Max(200, withParams({ min: -5, max: 200 }))
  floor: number;
}

export class HotspotDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A unit of the plan’s building and floor (UNIT_NOT_ON_FLOOR); each once (DUPLICATE_VALUE).',
  })
  @IsUUID()
  unitId: string;

  @Fraction('The box’s left edge, from the image’s.')
  x: number;

  @Fraction('The box’s top edge, from the image’s.')
  y: number;

  @Fraction(
    'More than 0; `x + width` at most 1 (HOTSPOT_OUTSIDE_IMAGE), after rounding to five decimals.',
  )
  width: number;

  @Fraction('More than 0; `y + height` at most 1 (HOTSPOT_OUTSIDE_IMAGE).')
  height: number;
}

export class SetHotspotsDto {
  @ApiProperty({
    type: [HotspotDto],
    description: `Every unit’s box on the plan, replacing them all; at most ${MAX_HOTSPOTS}.`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_HOTSPOTS, withParams({ min: 0, max: MAX_HOTSPOTS }))
  @ValidateNested({ each: true })
  @Type(() => HotspotDto)
  hotspots: HotspotDto[];
}

const GUESTS = withParams({ min: 0, max: SPACE_USE_RULES.guestsMax });

export class CreateSpaceUseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A common area open to requests (SPACE_USE_AREA_CLOSED).',
  })
  @IsUUID()
  commonAreaId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: `At least ${SPACE_USE_RULES.minHoursAhead} hours ahead (SPACE_USE_TOO_SOON), within ${SPACE_USE_RULES.maxDaysAhead} days (SPACE_USE_TOO_FAR).`,
  })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: `After the start (ENDS_BEFORE_START), at most ${SPACE_USE_RULES.maxHours} hours after it (SPACE_USE_TOO_LONG).`,
  })
  @ToInstant()
  @IsDate()
  endsAt: Date;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 500,
    description: 'What it is for, in the requester’s words: the staff read it.',
  })
  @IsString()
  @Length(1, 500, withParams({ min: 1, max: 500 }))
  purpose: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: 0,
    maximum: SPACE_USE_RULES.guestsMax,
    description: 'How many people beside the requester, a number. Default 0.',
  })
  @IsOptional()
  @IsInt(GUESTS)
  @Min(0, GUESTS)
  @Max(SPACE_USE_RULES.guestsMax, GUESTS)
  guests?: number;
}

export class SpaceUseReasonDto {
  @ApiProperty({
    type: String,
    description:
      'From the closed list `spaceUseWithdraw` (the residents), `spaceUseRefuse` or `spaceUseCancel` (the staff).',
  })
  @IsString()
  reasonCode: string;
}

export class SpaceUsesQueryDto extends PageQueryDto {}

export class StaffSpaceUsesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: SPACE_USE_STATUSES,
    required: false,
    description: '`pending` is the queue.',
  })
  @IsOptional()
  @IsIn(SPACE_USE_STATUSES, withParams({ allowed: [...SPACE_USE_STATUSES] }))
  status?: (typeof SPACE_USE_STATUSES)[number];

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;
}
