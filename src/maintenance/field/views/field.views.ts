import { ApiProperty } from '@nestjs/swagger';
import type {
  AssetReading,
  AssetReplacementRecommendation,
} from '@prisma/client';
import { AssetEventView, AssetView } from '../../assets/views/asset.views';
import { CommonAreaView } from '../../locations/views/common-area.views';
import type {
  FieldCard,
  ScanResult,
  UpcomingWork,
} from '../field-work.service';

class AssetReadingView {
  @ApiProperty({ type: String })
  value: string;
  @ApiProperty({ type: String, nullable: true })
  unit: string | null;
  @ApiProperty({ enum: ['run', 'manual'] })
  source: string;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;

  static from(r: AssetReading): AssetReadingView {
    return {
      value: r.value.toFixed(4),
      unit: r.unit,
      source: r.source,
      occurredAt: r.occurredAt,
    };
  }
}

class MetricReadingsView {
  @ApiProperty({ type: String })
  metricKey: string;
  @ApiProperty({ type: AssetReadingView })
  last: AssetReadingView;
  @ApiProperty({
    type: AssetReadingView,
    nullable: true,
    description: 'The one before, to compare.',
  })
  previous: AssetReadingView | null;
}

/** An asset as a technician sees it on site (ADR 0064). */
export class FieldAssetView {
  @ApiProperty({ type: AssetView })
  asset: AssetView;
  @ApiProperty({
    type: [AssetEventView],
    description: 'Its last 20 events, newest first.',
  })
  events: AssetEventView[];
  @ApiProperty({ type: [MetricReadingsView] })
  readings: MetricReadingsView[];

  static from(c: FieldCard): FieldAssetView {
    return {
      asset: AssetView.fromCard(c.card),
      events: c.events.map((e) => AssetEventView.from(e)),
      readings: c.readings.map((r) => ({
        metricKey: r.metricKey,
        last: AssetReadingView.from(r.last),
        previous: r.previous ? AssetReadingView.from(r.previous) : null,
      })),
    };
  }
}

/** A scanned tag: an asset's card, or an area. */
export class ScanResultView {
  @ApiProperty({ enum: ['asset', 'area'] })
  kind: 'asset' | 'area';
  @ApiProperty({ type: FieldAssetView, nullable: true })
  asset: FieldAssetView | null;
  @ApiProperty({ type: CommonAreaView, nullable: true })
  area: CommonAreaView | null;

  static from(r: ScanResult): ScanResultView {
    return {
      kind: r.asset ? 'asset' : 'area',
      asset: r.asset ? FieldAssetView.from(r.asset) : null,
      area: r.area ? CommonAreaView.from(r.area) : null,
    };
  }
}

/** A technician's recommendation to replace an asset (ADR 0064). */
export class ReplacementRecommendationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  assetId: string;
  @ApiProperty({ type: String })
  reasonCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The technician’s words.',
  })
  note: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  recommendedById: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  recommendedAt: Date;
  @ApiProperty({ enum: ['pending', 'accepted', 'declined'] })
  status: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  decisionReason: string | null;

  static from(
    r: AssetReplacementRecommendation,
  ): ReplacementRecommendationView {
    return {
      id: r.id,
      assetId: r.assetId,
      reasonCode: r.reasonCode,
      note: r.note,
      recommendedById: r.recommendedById,
      recommendedAt: r.recommendedAt,
      status: r.status,
      decidedAt: r.decidedAt,
      decisionReason: r.decisionReason,
    };
  }
}

/** Planned work coming in a technician's trade (ADR 0064). */
export class UpcomingWorkView {
  @ApiProperty({ type: String, format: 'uuid' })
  planId: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, format: 'uuid' })
  assetId: string;
  @ApiProperty({ type: String })
  assetCode: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Its work order, when it is mine already.',
  })
  ticketId: string | null;

  static from(u: UpcomingWork): UpcomingWorkView {
    return u;
  }
}

export class FaultCreatedView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The work order opened.',
  })
  id: string;
}
