import { ApiProperty } from '@nestjs/swagger';
import { PostView } from '../../roster/views/roster.views';
import { RunRouteView } from './run.views';

/** A route's runs over the period (ADR 0052). */
export class PatrolReportRouteView {
  @ApiProperty({ type: RunRouteView })
  route: RunRouteView;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({
    type: Number,
    description: 'Scheduled runs, cancelled ones left out.',
  })
  scheduled: number;
  @ApiProperty({
    type: Number,
    description: 'Runs a guard started unscheduled.',
  })
  adhoc: number;
  @ApiProperty({
    type: Number,
    description: 'Completed: every checkpoint scanned.',
  })
  done: number;
  @ApiProperty({ type: Number })
  late: number;
  @ApiProperty({ type: Number })
  missed: number;
  @ApiProperty({
    type: Number,
    description: 'Ended with checkpoints not scanned, timed out ones included.',
  })
  incomplete: number;
  @ApiProperty({ type: Number })
  cancelled: number;
  @ApiProperty({ type: Number })
  manualScans: number;
  @ApiProperty({ type: Number })
  suspectScans: number;
  @ApiProperty({
    type: Number,
    description: 'Scans received after their run ended (finished offline).',
  })
  lateScans: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'How long a completed run took, on average, in minutes.',
  })
  avgMinutes: number | null;
}

export class PatrolReportView {
  @ApiProperty({ type: String, format: 'date', example: '2026-11-01' })
  from: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-11-07' })
  to: string;
  @ApiProperty({
    type: [PatrolReportRouteView],
    description: 'Each route with runs planned in the period, by name.',
  })
  routes: PatrolReportRouteView[];
}
