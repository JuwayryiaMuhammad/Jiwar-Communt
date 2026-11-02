import { ApiProperty } from '@nestjs/swagger';
import { AudienceOccupancy } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
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

/** The CHECK `announcements_audience_units`. */
export const MAX_AUDIENCE_UNITS = 200;
const UNITS = { min: 1, max: MAX_AUDIENCE_UNITS };

/**
 * An announcement's audience (ADR 0080): buildings, or single units, never
 * both. Events and polls keep the buildings alone.
 */
export class AnnouncementAudienceDto extends AudienceDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    nullable: true,
    minItems: UNITS.min,
    maxItems: UNITS.max,
    description:
      'Single units of the compound, instead of buildings: their people within the occupancy. Null or absent: not by unit.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(UNITS.min, withParams(UNITS))
  @ArrayMaxSize(UNITS.max, withParams(UNITS))
  @IsUUID('all', { each: true })
  unitIds?: string[] | null;
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
    const { buildings, occupancy } = audienceOf(row);
    return { buildings, occupancy };
  }
}

/** An announcement's audience as the staff read it: its units too (ADR 0080). */
export class AnnouncementAudienceView extends AudienceView {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    nullable: true,
    description: 'Null: not by unit.',
  })
  unitIds: string[] | null;

  static fromAnnouncement(
    row: AudienceColumns & { audienceUnits: string[] },
  ): AnnouncementAudienceView {
    return {
      ...AudienceView.from(row),
      unitIds: row.audienceUnits.length ? [...row.audienceUnits] : null,
    };
  }
}

/**
 * The two columns every piece of content carries; no buildings is the
 * whole compound. An announcement has a third, its units (ADR 0080).
 */
export interface AudienceColumns {
  audienceBuildings: string[];
  audienceOccupancy: AudienceOccupancy;
  audienceUnits?: string[];
}

export const EVERYONE: Audience = { buildings: null, occupancy: 'everyone' };

export function audienceOf(row: AudienceColumns): {
  buildings: string[] | null;
  occupancy: AudienceOccupancy;
  units: string[] | null;
} {
  return {
    buildings: row.audienceBuildings.length ? [...row.audienceBuildings] : null,
    occupancy: row.audienceOccupancy,
    units: row.audienceUnits?.length ? [...row.audienceUnits] : null,
  };
}

/** An announcement's units column (ADR 0080), sorted, each once. */
export function unitColumns(audience: Audience): { audienceUnits: string[] } {
  return { audienceUnits: [...new Set(audience.units ?? [])].sort() };
}

export function audienceColumns(audience: Audience): {
  audienceBuildings: string[];
  audienceOccupancy: AudienceOccupancy;
} {
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
 * disagree.
 *
 * Nobody's places must be a condition nothing meets, and an empty `OR` is
 * not one: the query engine drops it, and the list would show everything
 * to someone who left. So it is one branch that no row can satisfy.
 */
export function audienceWhere(places: readonly CommunityPlace[]): {
  OR: {
    audienceOccupancy: { in: AudienceOccupancy[] };
    OR: { audienceBuildings: { isEmpty: true } | { has: string } }[];
  }[];
} {
  if (!places.length)
    return { OR: [{ audienceOccupancy: { in: [] }, OR: [] }] };
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

/**
 * `audienceWhere` for announcements (ADR 0080), whose audience may be
 * single units: each of the caller's places is a branch of its own, with
 * its unit's condition beside its occupancy and building, so a place in a
 * named unit never lends its unit to another place's capacity. Built from
 * `inAudience` as `audienceWhere` is.
 */
export function announcementAudienceWhere(places: readonly CommunityPlace[]): {
  OR: {
    audienceOccupancy: { in: AudienceOccupancy[] };
    AND: (
      | { OR: { audienceBuildings: { isEmpty: true } | { has: string } }[] }
      | { OR: { audienceUnits: { isEmpty: true } | { has: string } }[] }
    )[];
  }[];
} {
  if (!places.length)
    return {
      OR: [{ audienceOccupancy: { in: [] }, AND: [{ OR: [] }] }],
    };
  return {
    OR: places.map((place) => ({
      audienceOccupancy: {
        in: OCCUPANCIES.filter((occupancy) =>
          inAudience(place, { buildings: null, occupancy }),
        ),
      },
      AND: [
        {
          OR: [
            { audienceBuildings: { isEmpty: true as const } },
            ...(place.building === null
              ? []
              : [{ audienceBuildings: { has: place.building } }]),
          ],
        },
        {
          OR: [
            { audienceUnits: { isEmpty: true as const } },
            { audienceUnits: { has: place.unitId } },
          ],
        },
      ],
    })),
  };
}
