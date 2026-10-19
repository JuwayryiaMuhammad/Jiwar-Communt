import { ApiProperty } from '@nestjs/swagger';
import type { TrafficReport } from '../traffic-report.service';

export class TrafficVisitorsView {
  @ApiProperty({ type: Number, description: 'On a visitor pass.' })
  visitorPass: number;
  @ApiProperty({ type: Number, description: 'On a household’s approval.' })
  gateRequest: number;
  @ApiProperty({
    type: Number,
    description: 'On a field exception the management approved (ADR 0056).',
  })
  fieldException: number;
}

export class TrafficServiceVehiclesView {
  @ApiProperty({ type: Number })
  tanker: number;
  @ApiProperty({ type: Number })
  waste: number;
  @ApiProperty({ type: Number })
  delivery: number;
  @ApiProperty({ type: Number })
  other: number;
}

export class TrafficResidentVehiclesView {
  @ApiProperty({ type: Number })
  in: number;
  @ApiProperty({ type: Number })
  out: number;
}

export class TrafficCountsView {
  @ApiProperty({ type: TrafficVisitorsView, description: 'Who came in.' })
  visitors: TrafficVisitorsView;
  @ApiProperty({
    type: TrafficServiceVehiclesView,
    description: 'Service vehicles that came in, by kind.',
  })
  serviceVehicles: TrafficServiceVehiclesView;
  @ApiProperty({
    type: TrafficResidentVehiclesView,
    description: 'Resident vehicles the guards counted, in and out.',
  })
  residentVehicles: TrafficResidentVehiclesView;
}

export class TrafficGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
}

export class TrafficRowView extends TrafficCountsView {
  @ApiProperty({ type: String, example: '2026-11-04' })
  date: string;
  @ApiProperty({ type: TrafficGateView })
  gate: TrafficGateView;
}

/** The traffic report (ADR 0056): counts only, never a name, a unit or a plate. */
export class TrafficReportView {
  @ApiProperty({ type: String, example: '2026-11-01' })
  from: string;
  @ApiProperty({ type: String, example: '2026-11-07' })
  to: string;
  @ApiProperty({
    type: [TrafficRowView],
    description: 'By day, then gate by name.',
  })
  rows: TrafficRowView[];
  @ApiProperty({ type: TrafficCountsView })
  totals: TrafficCountsView;

  static from(r: TrafficReport): TrafficReportView {
    return r;
  }
}
