import { ApiProperty } from '@nestjs/swagger';
import { AccountRefView } from '../../../core/common/http/personal';
import { PostView } from '../../roster/views/roster.views';

export class DailyShiftView {
  @ApiProperty({ type: AccountRefView })
  guard: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'The slot it filled; null when unscheduled.',
  })
  scheduledStart: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  lateMinutes: number | null;
  @ApiProperty({ type: Boolean, description: 'More than ten minutes late.' })
  late: boolean;
  @ApiProperty({ type: Number, nullable: true })
  overtimeMinutes: number | null;
  @ApiProperty({ type: Number, nullable: true })
  unscheduledMinutes: number | null;
}

export class DailyCountsView {
  @ApiProperty({ type: Number, description: 'Slots starting this day.' })
  scheduledSlots: number;
  @ApiProperty({ type: Number })
  filledSlots: number;
  @ApiProperty({
    type: Number,
    description: 'Of the slots, opened more than ten minutes late.',
  })
  late: number;
  @ApiProperty({
    type: Number,
    description: 'Of the slots, not opened an hour after the start.',
  })
  absent: number;
  @ApiProperty({ type: Number, description: 'Shifts that filled no slot.' })
  unscheduledShifts: number;
  @ApiProperty({ type: Number })
  overtimeMinutes: number;
  @ApiProperty({ type: Number })
  tasksCreated: number;
  @ApiProperty({ type: Number })
  tasksDone: number;
  @ApiProperty({ type: Number, description: 'Open at the day’s end.' })
  tasksOpen: number;
  @ApiProperty({
    type: Number,
    description: 'Emergencies reported this day and answered from this gate.',
  })
  emergencies: number;
  @ApiProperty({
    type: Number,
    description:
      'Gate services accepted this day: a lane at this gate, or by a guard on shift here.',
  })
  gateServices: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Visitors in at this gate (passes and gate requests); null for a zone.',
  })
  visitors: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Contractor workers let in at this gate against a works permit (ADR 0049); null for a zone. Never in `visitors`.',
  })
  contractorWorkers: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Guests let in at this gate against an event’s list (ADR 0049); null for a zone. Never in `visitors`.',
  })
  eventGuests: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Move trucks let in at this gate against a move permit (ADR 0049); null for a zone.',
  })
  moveTrucks: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Materials the guards logged in at this gate (ADR 0049); null for a zone.',
  })
  materialEntries: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Material exits let out at this gate (a permit used, ADR 0049); null for a zone.',
  })
  materialExits: number | null;
  @ApiProperty({
    type: Number,
    description:
      'Incidents a guard on shift here reported this day (ADR 0053); at gates and in zones.',
  })
  incidents: number;
  @ApiProperty({
    type: Number,
    description:
      'Violations a guard on shift here issued this day (ADR 0053); at gates and in zones.',
  })
  violations: number;
}

/** The post's patrol runs planned this day (ADR 0052), gates and zones alike. */
export class DailyPatrolCountsView {
  @ApiProperty({
    type: Number,
    description: 'Scheduled runs planned this day, cancelled ones left out.',
  })
  scheduled: number;
  @ApiProperty({
    type: Number,
    description:
      'Runs completed: every checkpoint scanned (unscheduled ones too).',
  })
  done: number;
  @ApiProperty({
    type: Number,
    description: 'Scheduled runs not started 15 minutes after their start.',
  })
  late: number;
  @ApiProperty({ type: Number, description: 'Scheduled runs never started.' })
  missed: number;
  @ApiProperty({
    type: Number,
    description:
      'Runs ended with checkpoints not scanned, timed out ones included.',
  })
  incomplete: number;
}

export class DailyPostView {
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: [DailyShiftView], description: 'Started this day.' })
  shifts: DailyShiftView[];
  @ApiProperty({ type: DailyCountsView })
  counts: DailyCountsView;
  @ApiProperty({ type: DailyPatrolCountsView })
  patrols: DailyPatrolCountsView;
}

export class DailyReportView {
  @ApiProperty({ type: String, format: 'date', example: '2026-11-05' })
  date: string;
  @ApiProperty({
    type: [DailyPostView],
    description: 'Every gate by name; then the zones where something happened.',
  })
  posts: DailyPostView[];
}
