import { ApiProperty } from '@nestjs/swagger';
import { PresignedReadView } from '../../../core/files/views/file.views';
import type {
  FloorPlanRead,
  FloorPlanSummary,
  HotspotRead,
  UnitFloorPlanRead,
} from '../floor-plans.service';
import {
  MAP_POINT_KINDS,
  type MapPointRead,
  type SiteMapRead,
} from '../site-map.service';
import {
  SPACE_USE_STATUSES,
  type SpaceUseAreaRead,
  type SpaceUseRead,
} from '../space-uses.service';

/** A place on the site map (ADR 0084). */
export class MapPointView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: MAP_POINT_KINDS })
  kind: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The building’s, gate’s or facility’s id.',
  })
  refId: string;
  @ApiProperty({ type: String, description: 'Its name, as the place has it.' })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({
    type: Number,
    description: 'A fraction of the width, from the left.',
  })
  x: number;
  @ApiProperty({
    type: Number,
    description: 'A fraction of the height, from the top.',
  })
  y: number;

  static from(p: MapPointRead): MapPointView {
    return { ...p };
  }
}

/** The compound's site map (ADR 0084): no-store (a presigned image). */
export class SiteMapView {
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description: 'Null until the management sets one.',
  })
  image: PresignedReadView | null;
  @ApiProperty({ type: [MapPointView] })
  points: MapPointView[];

  static from(m: SiteMapRead): SiteMapView {
    return {
      image: PresignedReadView.from(m.image),
      points: m.points.map((p) => MapPointView.from(p)),
    };
  }
}

/** A building floor's plan, listed (ADR 0084). */
export class FloorPlanSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  buildingId: string;
  @ApiProperty({ type: String })
  buildingName: string;
  @ApiProperty({ type: Number })
  floor: number;
  @ApiProperty({ type: Number, description: 'Units boxed on it.' })
  hotspots: number;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(p: FloorPlanSummary): FloorPlanSummaryView {
    return { ...p };
  }
}

/** A unit's box on a plan, as the staff see it. */
export class HotspotView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: Number })
  x: number;
  @ApiProperty({ type: Number })
  y: number;
  @ApiProperty({ type: Number })
  width: number;
  @ApiProperty({ type: Number })
  height: number;
  @ApiProperty({
    type: Boolean,
    description:
      'The unit is no longer on the plan’s building and floor: draw it again on its own.',
  })
  misplaced: boolean;

  static from(h: HotspotRead): HotspotView {
    return { ...h };
  }
}

/** A floor plan with its units' boxes (ADR 0084): no-store. */
export class FloorPlanView extends FloorPlanSummaryView {
  @ApiProperty({ type: PresignedReadView, nullable: true })
  image: PresignedReadView | null;
  @ApiProperty({ type: [HotspotView] })
  units: HotspotView[];

  static fromRead(p: FloorPlanRead): FloorPlanView {
    return {
      ...FloorPlanSummaryView.from(p),
      image: PresignedReadView.from(p.image),
      units: p.units.map((h) => HotspotView.from(h)),
    };
  }
}

/** A box on an image, in fractions of its width and height. */
export class BoxView {
  @ApiProperty({ type: Number })
  x: number;
  @ApiProperty({ type: Number })
  y: number;
  @ApiProperty({ type: Number })
  width: number;
  @ApiProperty({ type: Number })
  height: number;
}

/**
 * A unit's floor plan as its household sees it (ADR 0084): the image and
 * the unit's own box — never another unit's, nor anyone in them.
 */
export class UnitFloorPlanView {
  @ApiProperty({ type: String })
  buildingName: string;
  @ApiProperty({ type: Number })
  floor: number;
  @ApiProperty({ type: PresignedReadView, nullable: true })
  image: PresignedReadView | null;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    type: BoxView,
    nullable: true,
    description: 'The unit’s own box; null when it has none on the plan.',
  })
  box: BoxView | null;

  static from(p: UnitFloorPlanRead): UnitFloorPlanView {
    return { ...p, image: PresignedReadView.from(p.image) };
  }
}

/** A common area open to use requests (ADR 0084). */
export class SpaceUseAreaView {
  @ApiProperty({ type: String, format: 'uuid' })
  commonAreaId: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The facility it is, if any: an approved use closes it to bookings then.',
  })
  facilityId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: Date;

  static from(a: SpaceUseAreaRead): SpaceUseAreaView {
    return { ...a };
  }
}

/** A common-area use request (ADR 0084). */
export class SpaceUseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  commonAreaId: string;
  @ApiProperty({ type: String })
  areaCode: string;
  @ApiProperty({ type: String })
  areaNameEn: string;
  @ApiProperty({ type: String })
  areaNameAr: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  facilityId: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The requester’s words; null once they were erased.',
  })
  purpose: string | null;
  @ApiProperty({ type: Number })
  guests: number;
  @ApiProperty({ enum: SPACE_USE_STATUSES })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A refusal’s or a cancel’s code (`spaceUseRefuse`, `spaceUseCancel`, `spaceUseWithdraw`, or `requester_left`).',
  })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: SpaceUseRead): SpaceUseView {
    const q = r.request;
    return {
      id: q.id,
      commonAreaId: q.commonAreaId,
      areaCode: r.areaCode,
      areaNameEn: r.areaNameEn,
      areaNameAr: r.areaNameAr,
      facilityId: r.facilityId,
      unitId: q.unitId,
      unitCode: r.unitCode,
      startsAt: q.startsAt,
      endsAt: q.endsAt,
      purpose: q.purpose,
      guests: q.guests,
      status: q.status,
      reasonCode: q.reasonCode,
      decidedAt: q.decidedAt,
      endedAt: q.endedAt,
      createdAt: q.createdAt,
    };
  }
}

/** As the household reads it: whether it is the caller's own. */
export class ResidentSpaceUseView extends SpaceUseView {
  @ApiProperty({ type: Boolean, description: 'The caller asked for it.' })
  mine: boolean;

  static of(r: SpaceUseRead, accountId: string): ResidentSpaceUseView {
    return {
      ...SpaceUseView.from(r),
      mine: r.request.requestedById === accountId,
    };
  }
}
