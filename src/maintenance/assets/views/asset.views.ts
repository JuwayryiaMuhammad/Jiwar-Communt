import { ApiProperty } from '@nestjs/swagger';
import type { Asset, AssetEvent } from '@prisma/client';
import { COMMON_AREA_KINDS } from '../../locations/area-rules';
import { ofDateColumnOrNull } from '../../schedules/local-dates';
import {
  ASSET_CONDITIONS,
  ASSET_CRITICALITIES,
  ASSET_STATUSES,
  type AssetCondition,
  type AssetCriticality,
  type AssetStatus,
} from '../asset-rules';
import type { AssetCard } from '../assets.service';

const money = (d: { toFixed(n: number): string } | null) =>
  d === null ? null : d.toFixed(2);

/** An asset in a list (ADR 0064). */
export class AssetSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, format: 'uuid' })
  typeId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  parentId: string | null;
  @ApiProperty({ type: Number, description: '1 for a root.' })
  depth: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  commonAreaId: string | null;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ enum: ASSET_STATUSES })
  status: AssetStatus;
  @ApiProperty({ enum: ASSET_CONDITIONS })
  condition: AssetCondition;
  @ApiProperty({ enum: ASSET_CRITICALITIES })
  criticality: AssetCriticality;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  warrantyEndsOn: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(a: Asset): AssetSummaryView {
    return {
      id: a.id,
      code: a.code,
      typeId: a.typeId,
      parentId: a.parentId,
      depth: a.depth,
      unitId: a.unitId,
      commonAreaId: a.commonAreaId,
      nameAr: a.nameAr,
      nameEn: a.nameEn,
      status: a.status as AssetStatus,
      condition: a.condition as AssetCondition,
      criticality: a.criticality as AssetCriticality,
      warrantyEndsOn: ofDateColumnOrNull(a.warrantyEndsOn),
      createdAt: a.createdAt,
    };
  }
}

class AssetTypeRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String, format: 'uuid' })
  categoryId: string;
}

class AssetAreaRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: COMMON_AREA_KINDS })
  kind: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
}

class AssetHealthView {
  @ApiProperty({ type: Number, minimum: 0, maximum: 100 })
  score: number;
  @ApiProperty({ enum: ['good', 'watch', 'poor'] })
  band: 'good' | 'watch' | 'poor';
}

/**
 * An asset's card (ADR 0064): where it is, what it is, its warranty and
 * values, and its health by rule (null once retired).
 */
export class AssetView extends AssetSummaryView {
  @ApiProperty({ type: AssetTypeRefView })
  type: AssetTypeRefView;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The unit’s code, when it is in one.',
  })
  unitCode: string | null;
  @ApiProperty({ type: AssetAreaRefView, nullable: true })
  commonArea: AssetAreaRefView | null;
  @ApiProperty({ type: String, nullable: true })
  manufacturer: string | null;
  @ApiProperty({ type: String, nullable: true })
  model: string | null;
  @ApiProperty({ type: String, nullable: true })
  serialNumber: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  commissionedOn: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  purchaseValue: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  replacementCost: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'EGP a day.' })
  downtimeCostPerDay: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Its own, or its type’s.',
  })
  lifeYears: number | null;
  @ApiProperty({ type: Number, nullable: true })
  ageYears: number | null;
  @ApiProperty({ type: String, nullable: true })
  vendorName: string | null;
  @ApiProperty({ type: String, nullable: true })
  vendorPhone: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'The warranty runs today (the compound’s).',
  })
  underWarranty: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it is out of service or retired.',
  })
  statusReason: string | null;
  @ApiProperty({ type: [String] })
  servesBuildings: string[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  tagIssuedAt: Date | null;
  @ApiProperty({ type: Number, description: 'Its parts not retired.' })
  childCount: number;
  @ApiProperty({ type: AssetHealthView, nullable: true })
  health: AssetHealthView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static fromCard(c: AssetCard): AssetView {
    const a = c.asset;
    const warranty = ofDateColumnOrNull(a.warrantyEndsOn);
    return {
      ...AssetSummaryView.from(a),
      type: {
        id: c.type.id,
        key: c.type.key,
        nameAr: c.type.nameAr,
        nameEn: c.type.nameEn,
        categoryId: c.type.categoryId,
      },
      unitCode: c.place.unitCode,
      commonArea: c.place.commonArea,
      manufacturer: a.manufacturer,
      model: a.model,
      serialNumber: a.serialNumber,
      commissionedOn: ofDateColumnOrNull(a.commissionedOn),
      purchaseValue: money(a.purchaseValue),
      replacementCost: money(a.replacementCost),
      downtimeCostPerDay: money(a.downtimeCostPerDay),
      lifeYears: c.lifeYears,
      ageYears: c.ageYears,
      vendorName: a.vendorName,
      vendorPhone: a.vendorPhone,
      underWarranty: warranty !== null && warranty >= c.today,
      statusReason: a.statusReason,
      servesBuildings: a.servesBuildings,
      retiredAt: a.retiredAt,
      tagIssuedAt: a.tagIssuedAt,
      childCount: c.childCount,
      health: c.health,
      updatedAt: a.updatedAt,
    };
  }
}

/** One entry of an asset's history: codes, never words. */
export class AssetEventView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: [
      'created',
      'imported',
      'updated',
      'condition_changed',
      'status_changed',
      'moved',
      'retired',
      'tag_issued',
    ],
  })
  kind: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A code: the old status or condition, `unit:<id>` or `area:<id>` before a move.',
  })
  fromValue: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A code; for `updated`, the fields that changed, comma-separated.',
  })
  toValue: string | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;

  static from(e: AssetEvent): AssetEventView {
    return {
      id: e.id,
      kind: e.kind,
      fromValue: e.fromValue,
      toValue: e.toValue,
      reasonCode: e.reasonCode,
      actorId: e.actorId,
      occurredAt: e.occurredAt,
    };
  }
}

/** Who an asset's failure reaches: counts only. */
export class AssetImpactView {
  @ApiProperty({ type: [String] })
  buildings: string[];
  @ApiProperty({ type: Number })
  units: number;
  @ApiProperty({ type: Number })
  occupiedUnits: number;
}
