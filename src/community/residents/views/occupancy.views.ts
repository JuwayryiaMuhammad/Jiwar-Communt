import { ApiProperty } from '@nestjs/swagger';
import {
  OccupancyEndReason,
  OccupancyStatus,
  OccupancyType,
  UnitReviewReason,
  UnitType,
} from '@prisma/client';
import { AccountRefView, accountRef } from '../../../core/common/http/personal';
import type {
  OccupancyView,
  UnitDetail,
  UnitNeedingReview,
  UnitOccupant,
} from '../residents.types';

export class OccupancyResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  occupancyType: OccupancyType;
  @ApiProperty({ type: Boolean, description: 'False for an owner-landlord.' })
  resides: boolean;
  @ApiProperty({ type: Boolean })
  isPrimary: boolean;
  @ApiProperty({ enum: OccupancyStatus, enumName: 'OccupancyStatus' })
  status: OccupancyStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    enum: OccupancyEndReason,
    enumName: 'OccupancyEndReason',
    nullable: true,
  })
  endReason: OccupancyEndReason | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  handedOverAt: Date | null;

  static from(o: OccupancyView): OccupancyResponse {
    return {
      id: o.id,
      unitId: o.unitId,
      unitCode: o.unitCode,
      occupancyType: o.occupancyType,
      resides: o.resides,
      isPrimary: o.isPrimary,
      status: o.status,
      startedAt: o.startedAt,
      endedAt: o.endedAt,
      endReason: o.endReason,
      handedOverAt: o.handedOverAt,
    };
  }
}

export class UnitOccupantView {
  @ApiProperty({ type: String, format: 'uuid' })
  occupancyId: string;
  @ApiProperty({ type: AccountRefView })
  account: AccountRefView;
  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  occupancyType: OccupancyType;
  @ApiProperty({ type: Boolean })
  resides: boolean;
  @ApiProperty({ type: Boolean })
  isPrimary: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;

  static from(o: UnitOccupant): UnitOccupantView {
    return {
      occupancyId: o.occupancyId,
      account: accountRef(o.account),
      occupancyType: o.occupancyType,
      resides: o.resides,
      isPrimary: o.isPrimary,
      startedAt: o.startedAt,
    };
  }
}

/** An open review flag of a unit (ADR 0021): what `POST /review-flags/{id}/clear` names. */
export class UnitReviewFlagView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: UnitReviewReason, enumName: 'UnitReviewReason' })
  reason: UnitReviewReason;
  @ApiProperty({ type: String, format: 'date-time' })
  flaggedAt: Date;
}

/** One unit. The review flags and `occupants` are for managers only. */
export class UnitDetailView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: Number, nullable: true })
  floor: number | null;
  @ApiProperty({ enum: UnitType, enumName: 'UnitType', nullable: true })
  unitType: UnitType | null;
  @ApiProperty({ type: String, nullable: true, example: '120.50' })
  areaSqm: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Closed-unit mode (the owner is away).',
  })
  closed: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({
    enum: UnitReviewReason,
    enumName: 'UnitReviewReason',
    isArray: true,
    required: false,
    description: 'Managers only.',
  })
  reviewReasons?: UnitReviewReason[];
  @ApiProperty({
    type: [UnitReviewFlagView],
    required: false,
    description:
      'Managers only: the open flags behind `reviewReasons`, oldest first.',
  })
  reviewFlags?: UnitReviewFlagView[];
  @ApiProperty({
    type: [UnitOccupantView],
    required: false,
    description: 'Managers only.',
  })
  occupants?: UnitOccupantView[];

  static from(u: UnitDetail): UnitDetailView {
    return {
      id: u.id,
      code: u.code,
      building: u.building,
      floor: u.floor,
      unitType: u.unitType,
      areaSqm: u.areaSqm,
      closed: u.closed,
      createdAt: u.createdAt,
      ...(u.management
        ? {
            reviewReasons: u.management.reviewReasons,
            reviewFlags: u.management.reviewFlags.map((f) => ({
              id: f.id,
              reason: f.reason,
              flaggedAt: f.flaggedAt,
            })),
            occupants: u.management.occupants.map((o) =>
              UnitOccupantView.from(o),
            ),
          }
        : {}),
    };
  }
}

/** A unit whose household needs attention; never the notes behind it. */
export class UnitNeedingReviewView {
  @ApiProperty({ type: String, format: 'uuid' })
  flagId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ enum: UnitReviewReason, enumName: 'UnitReviewReason' })
  reason: UnitReviewReason;
  @ApiProperty({ type: String, format: 'date-time' })
  flaggedAt: Date;
  @ApiProperty({ type: Number })
  activeOccupants: number;

  static from(u: UnitNeedingReview): UnitNeedingReviewView {
    return {
      flagId: u.flagId,
      unitId: u.unitId,
      code: u.code,
      reason: u.reason,
      flaggedAt: u.flaggedAt,
      activeOccupants: u.activeOccupants,
    };
  }
}

export class ActivationView {
  @ApiProperty({ enum: ['unitType', 'areaSqm', 'building'], isArray: true })
  missing: ('unitType' | 'areaSqm' | 'building')[];
}
