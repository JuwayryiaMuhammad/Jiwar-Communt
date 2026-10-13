import { ApiProperty } from '@nestjs/swagger';
import { AudienceOccupancy } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import {
  inAudience,
  type Audience,
  type CommunityPlace,
} from '../../community';
import { withParams } from '../../core/common/validation/validation-errors';

/** The CHECK `*_audience_buildings`. */
export const MAX_AUDIENCE_BUILDINGS = 50;
const BUILDINGS = { min: 1, max: MAX_AUDIENCE_BUILDINGS };
const BUILDING_NAME = { min: 1, max: 100 };

const OCCUPANCIES = Object.values(AudienceOccupancy);

/** Who a piece of content is put to. Absent: the whole compound, everyone. */
export class AudienceDto {
  @ApiProperty({
    type: [String],
    required: false,
    nullable: true,
    minItems: BUILDINGS.min,
    maxItems: BUILDINGS.max,
    description:
      'Buildings, as `GET /community/buildings` lists them. Null or absent: the whole compound.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(BUILDINGS.min, withParams(BUILDINGS))
  @ArrayMaxSize(BUILDINGS.max, withParams(BUILDINGS))
  @IsString({ each: true })
  @Length(BUILDING_NAME.min, BUILDING_NAME.max, {
    each: true,
    ...withParams(BUILDING_NAME),
  })
  buildings?: string[] | null;

  @ApiProperty({
    enum: AudienceOccupancy,
    enumName: 'AudienceOccupancy',
    description:
      '`owners`: the active owners of a unit, landlords included, and nobody else. `tenants`: the tenants and their households.',
  })
  @IsEnum(AudienceOccupancy, withParams({ allowed: OCCUPANCIES }))
  occupancy: AudienceOccupancy;
}

/** The audience as it is stored and shown. */
export class AudienceView {
  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'Null: the whole compound.',
  })
  buildings: string[] | null;
  @ApiProperty({ enum: AudienceOccupancy, enumName: 'AudienceOccupancy' })
  occupancy: AudienceOccupancy;

  static from(row: AudienceColumns): AudienceView {
    return { ...audienceOf(row) };
  }
}

/** The two columns every piece of content carries; no buildings is the whole compound. */
export interface AudienceColumns {
  audienceBuildings: string[];
  audienceOccupancy: AudienceOccupancy;
}

export const EVERYONE: Audience = { buildings: null, occupancy: 'everyone' };

export function audienceOf(row: AudienceColumns): {
  buildings: string[] | null;
  occupancy: AudienceOccupancy;
} {
  return {
    buildings: row.audienceBuildings.length ? [...row.audienceBuildings] : null,
    occupancy: row.audienceOccupancy,
  };
}

export function audienceColumns(audience: Audience): AudienceColumns {
  return {
    audienceBuildings: [...new Set(audience.buildings ?? [])].sort(),
    audienceOccupancy: audience.occupancy,
  };
}

/** Whether any of the caller's places is in the content's audience. */
export function sees(
  places: readonly CommunityPlace[],
  row: AudienceColumns,
): boolean {
  const audience = audienceOf(row);
  return places.some((p) => inAudience(p, audience));
}

/** The caller's places that are in the content's audience. */
export function placesIn(
  places: readonly CommunityPlace[],
  row: AudienceColumns,
): CommunityPlace[] {
  const audience = audienceOf(row);
  return places.filter((p) => inAudience(p, audience));
}

/**
 * `sees` as a query condition over the two audience columns: the content
 * put to at least one of the caller's places. Built from `inAudience`
 * itself, one capacity at a time, so the list and the single read never
 * disagree. Nobody's places: a condition nothing meets.
 */
export function audienceWhere(places: readonly CommunityPlace[]): {
  OR: {
    audienceOccupancy: { in: AudienceOccupancy[] };
    OR: { audienceBuildings: { isEmpty: true } | { has: string } }[];
  }[];
} {
  return {
    OR: places.map((place) => ({
      audienceOccupancy: {
        in: OCCUPANCIES.filter((occupancy) =>
          inAudience(place, { buildings: null, occupancy }),
        ),
      },
      OR: [
        { audienceBuildings: { isEmpty: true as const } },
        ...(place.building === null
          ? []
          : [{ audienceBuildings: { has: place.building } }]),
      ],
    })),
  };
}
