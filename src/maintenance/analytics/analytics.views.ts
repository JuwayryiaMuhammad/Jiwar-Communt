import { ApiProperty } from '@nestjs/swagger';
import type { CaseDetail, CaseRead } from './cases.service';
import { CASE_STATUSES } from './cases.service';
import type { MapArea, MapBuilding } from './complaints-map';
import type { SuggestionRead } from './plan-suggestions.service';
import { SUGGESTION_STATUSES } from './plan-suggestions.service';
import { RECURRENCE_PLACES, type RecurrenceRow } from './recurrence';
import { ticketNumber } from '../tickets/ticket-rules';

export class RecurrenceMonthView {
  @ApiProperty({ type: String, example: '2027-03' })
  month: string;
  @ApiProperty({ type: Number })
  count: number;
}

export class RecurrenceRowView {
  @ApiProperty({ type: String, format: 'uuid' })
  placeId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The asset’s, unit’s or area’s code; the building’s name.',
  })
  placeCode: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  categoryId: string;
  @ApiProperty({ type: String })
  categoryKey: string;
  @ApiProperty({ type: Number })
  count: number;
  @ApiProperty({ type: String, format: 'date-time' })
  firstAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  lastAt: Date;
  @ApiProperty({
    type: Number,
    description: 'Mean days between consecutive tickets, one decimal.',
  })
  meanIntervalDays: number;
  @ApiProperty({
    type: String,
    example: '1250.00',
    description: 'EGP recorded on those tickets, voided entries left out.',
  })
  cost: string;
  @ApiProperty({ type: [RecurrenceMonthView] })
  months: RecurrenceMonthView[];

  static from(r: RecurrenceRow): RecurrenceRowView {
    return { ...r, months: r.months.map((m) => ({ ...m })) };
  }
}

export class RecurrenceReportView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ enum: RECURRENCE_PLACES, enumName: 'RecurrencePlace' })
  by: string;
  @ApiProperty({ type: Number, description: 'The threshold applied.' })
  min: number;
  @ApiProperty({
    type: Boolean,
    description: 'More rows than the 500 shown.',
  })
  truncated: boolean;
  @ApiProperty({ type: [RecurrenceRowView] })
  rows: RecurrenceRowView[];
}

export class MapCategoryView {
  @ApiProperty({ type: String })
  categoryKey: string;
  @ApiProperty({ type: Number })
  count: number;
}

export class MapBuildingView {
  @ApiProperty({ type: String, format: 'uuid' })
  buildingId: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ type: Number, nullable: true })
  latitude: number | null;
  @ApiProperty({ type: Number, nullable: true })
  longitude: number | null;
  @ApiProperty({ type: Number })
  total: number;
  @ApiProperty({ type: Number, description: 'Neither closed nor cancelled.' })
  open: number;
  @ApiProperty({ type: Number, description: 'Opened by residents.' })
  residents: number;
  @ApiProperty({
    type: [MapCategoryView],
    description: 'The five categories with the most.',
  })
  categories: MapCategoryView[];

  static from(b: MapBuilding): MapBuildingView {
    return { ...b, categories: b.categories.map((c) => ({ ...c })) };
  }
}

export class MapAreaView {
  @ApiProperty({ type: String, format: 'uuid' })
  commonAreaId: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, description: 'building, area, facility.' })
  kind: string;
  @ApiProperty({ type: Number, nullable: true })
  latitude: number | null;
  @ApiProperty({ type: Number, nullable: true })
  longitude: number | null;
  @ApiProperty({ type: Number })
  total: number;
  @ApiProperty({ type: Number })
  open: number;

  static from(a: MapArea): MapAreaView {
    return { ...a };
  }
}

export class ComplaintsMapView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: [MapBuildingView] })
  buildings: MapBuildingView[];
  @ApiProperty({ type: [MapAreaView] })
  areas: MapAreaView[];
}

export class PlanSuggestionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'An asset of a common area; else `unitId`.',
  })
  assetId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, nullable: true })
  placeCode: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  categoryId: string;
  @ApiProperty({ type: String })
  categoryKey: string;
  @ApiProperty({ type: Number })
  ticketCount: number;
  @ApiProperty({ type: Number })
  windowDays: number;
  @ApiProperty({ type: String, format: 'date-time' })
  firstTicketAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  lastTicketAt: Date;
  @ApiProperty({ enum: SUGGESTION_STATUSES, enumName: 'PlanSuggestionStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  planId: string | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Accepted: whether the plan was made for it.',
  })
  planCreated: boolean | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;

  static from(r: SuggestionRead): PlanSuggestionView {
    const s = r.suggestion;
    return {
      id: s.id,
      assetId: s.assetId,
      unitId: s.unitId,
      placeCode: r.placeCode,
      categoryId: s.categoryId,
      categoryKey: r.categoryKey,
      ticketCount: s.ticketCount,
      windowDays: s.windowDays,
      firstTicketAt: s.firstTicketAt,
      lastTicketAt: s.lastTicketAt,
      status: s.status,
      createdAt: s.createdAt,
      decidedAt: s.decidedAt,
      planId: s.planId,
      planCreated: s.planCreated,
      reasonCode: s.reasonCode,
    };
  }
}

export class CaseWorkOrderView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  number: string;
  @ApiProperty({ type: String })
  status: string;
}

export class MaintenanceCaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  categoryId: string;
  @ApiProperty({ type: String })
  categoryKey: string;
  @ApiProperty({ type: String, format: 'uuid' })
  buildingId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the building was deleted.',
  })
  buildingName: string | null;
  @ApiProperty({ enum: CASE_STATUSES, enumName: 'MaintenanceCaseStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'Opened by itself, at the threshold.',
  })
  automatic: boolean;
  @ApiProperty({
    type: Number,
    description: 'Its tickets the reader may see.',
  })
  ticketCount: number;
  @ApiProperty({ type: CaseWorkOrderView, nullable: true })
  workOrder: CaseWorkOrderView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;

  static from(r: CaseRead): MaintenanceCaseView {
    const c = r.row;
    return {
      id: c.id,
      categoryId: c.categoryId,
      categoryKey: r.categoryKey,
      buildingId: c.buildingId,
      buildingName: r.buildingName,
      status: c.status,
      openedAt: c.openedAt,
      automatic: c.openedById === null,
      ticketCount: r.ticketCount,
      workOrder: r.workOrder
        ? {
            id: r.workOrder.id,
            number: ticketNumber(r.workOrder.number),
            status: r.workOrder.status,
          }
        : null,
      closedAt: c.closedAt,
      reasonCode: c.reasonCode,
    };
  }
}

export class CaseTicketView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  number: string;
  @ApiProperty({ type: String })
  status: string;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  linkedAt: Date;
}

export class MaintenanceCaseDetailView extends MaintenanceCaseView {
  @ApiProperty({
    type: [CaseTicketView],
    description: 'Its tickets the reader may see, in the order they joined.',
  })
  tickets: CaseTicketView[];

  static fromDetail(d: CaseDetail): MaintenanceCaseDetailView {
    return {
      ...MaintenanceCaseView.from(d),
      tickets: d.tickets.map((t) => ({
        ...t,
        number: ticketNumber(t.number),
      })),
    };
  }
}
