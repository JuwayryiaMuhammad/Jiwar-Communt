import { ApiProperty } from '@nestjs/swagger';
import type {
  PatrolCheckpoint,
  PatrolRoute,
  PatrolRouteVersion,
  PatrolRun,
} from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import type { DutyNames } from '../../roster/duty-names';
import { PostView } from '../../roster/views/roster.views';
import { timeoutAt } from '../patrol-rules';
import { CheckpointPositionView } from './checkpoint.views';

export interface RunContext {
  names: DutyNames;
  routes: Map<string, PatrolRoute>;
  versions: Map<string, PatrolRouteVersion>;
  /** Per version: its checkpoints in the order walked. */
  stops: Map<string, PatrolCheckpoint[]>;
}

const KIND = { enum: ['scheduled', 'adhoc'], enumName: 'PatrolRunKind' };
const STATUS = {
  enum: [
    'scheduled',
    'in_progress',
    'completed',
    'incomplete',
    'timed_out',
    'missed',
    'cancelled',
  ],
  enumName: 'PatrolRunStatus',
};

export class RunRouteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
}

/** What every run view says (ADR 0052). */
class RunBodyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: RunRouteView })
  route: RunRouteView;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty(KIND)
  kind: string;
  @ApiProperty(STATUS)
  status: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When it was meant: the scheduled start, or an unscheduled run’s start.',
  })
  plannedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledStart: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'A scheduled run may be started from 15 minutes before its start until then.',
  })
  windowEndsAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    enum: ['guard', 'shift_ended'],
    enumName: 'PatrolRunEndReason',
    nullable: true,
    description: 'Why an incomplete run ended.',
  })
  endReason: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Not started 15 minutes after its scheduled start.',
  })
  late: boolean;
  @ApiProperty({ type: Number })
  checkpointsTotal: number;
  @ApiProperty({ type: Number })
  scannedCount: number;
}

function body(r: PatrolRun, c: RunContext): RunBodyView {
  const route = c.routes.get(r.routeId)!;
  return {
    id: r.id,
    route: { id: route.id, nameEn: route.nameEn, nameAr: route.nameAr },
    post: PostView.of(r, c.names),
    kind: r.kind,
    status: r.status,
    plannedAt: r.plannedAt,
    scheduledStart: r.scheduledStart,
    windowEndsAt: r.windowEndsAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    endReason: r.endReason,
    late: r.lateAt !== null,
    checkpointsTotal: r.checkpointsTotal,
    scannedCount: r.scannedCount,
  };
}

const person = <V>(
  id: string | null,
  c: RunContext,
  as: (a: { id: string; fullName: string | null; status: string }) => V,
): V | null => {
  const a = id ? c.names.people.get(id) : undefined;
  return a ? as(a) : null;
};

/** A run as the management reads it: the guard by full name. */
export class RunView extends RunBodyView {
  @ApiProperty({ type: AccountRefView, nullable: true })
  guard: AccountRefView | null;
  @ApiProperty({
    enum: [
      'not_needed',
      'post_closed',
      'other',
      'route_changed',
      'route_retired',
      'post_out_of_service',
    ],
    enumName: 'PatrolRunCancelReason',
    nullable: true,
  })
  cancelReason: string | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null when the system cancelled it.',
  })
  cancelledBy: AccountRefView | null;

  static of(r: PatrolRun, c: RunContext): RunView {
    return {
      ...body(r, c),
      guard: person(r.guardAccountId, c, accountRef),
      cancelReason: r.cancelReason,
      cancelledBy: person(r.cancelledById, c, accountRef),
    };
  }
}

/** A run as a guard reads it: colleagues by first name. */
export class GuardRunView extends RunBodyView {
  @ApiProperty({ type: FirstNameRefView, nullable: true })
  guard: FirstNameRefView | null;

  static from(r: PatrolRun, c: RunContext): GuardRunView {
    return { ...body(r, c), guard: person(r.guardAccountId, c, firstNameRef) };
  }
}

/** A checkpoint of the run's version, at its place in the walk. */
export class RunStopView {
  @ApiProperty({ type: Number, description: '1 for the first.' })
  position: number;
  @ApiProperty({ type: String, format: 'uuid' })
  checkpointId: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: CheckpointPositionView, nullable: true })
  location: CheckpointPositionView | null;
}

/** What a run asks of the guard: its version, its checkpoints in order. */
class RunWalkView {
  @ApiProperty({
    type: Boolean,
    description: 'The checkpoints are scanned in this order.',
  })
  ordered: boolean;
  @ApiProperty({ type: Number })
  expectedMinutes: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Under way: when it is closed as timed out (twice the expected minutes).',
  })
  timesOutAt: Date | null;
  @ApiProperty({ type: [RunStopView] })
  stops: RunStopView[];
}

function walk(r: PatrolRun, c: RunContext): RunWalkView {
  const version = c.versions.get(r.versionId)!;
  return {
    ordered: version.ordered,
    expectedMinutes: version.expectedMinutes,
    timesOutAt:
      r.status === 'in_progress' && r.startedAt
        ? timeoutAt(r.startedAt, version.expectedMinutes)
        : null,
    stops: (c.stops.get(r.versionId) ?? []).map((cp, i) => ({
      position: i + 1,
      checkpointId: cp.id,
      nameEn: cp.nameEn,
      nameAr: cp.nameAr,
      location: CheckpointPositionView.of(cp),
    })),
  };
}

export class RunDetailView extends RunView {
  @ApiProperty({ type: Boolean })
  ordered: boolean;
  @ApiProperty({ type: Number })
  expectedMinutes: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  timesOutAt: Date | null;
  @ApiProperty({ type: [RunStopView] })
  stops: RunStopView[];

  static from(r: PatrolRun, c: RunContext): RunDetailView {
    return { ...RunView.of(r, c), ...walk(r, c) };
  }
}

export class GuardRunDetailView extends GuardRunView {
  @ApiProperty({ type: Boolean })
  ordered: boolean;
  @ApiProperty({ type: Number })
  expectedMinutes: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  timesOutAt: Date | null;
  @ApiProperty({ type: [RunStopView] })
  stops: RunStopView[];

  static from(r: PatrolRun, c: RunContext): GuardRunDetailView {
    return { ...GuardRunView.from(r, c), ...walk(r, c) };
  }
}

/** A route a guard may start at their post. */
export class BoardRouteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
  @ApiProperty({ type: Boolean })
  ordered: boolean;
  @ApiProperty({ type: Number })
  expectedMinutes: number;
  @ApiProperty({ type: Number })
  checkpoints: number;
}

/** The guard's patrols at their post (ADR 0052). */
export class PatrolBoardView {
  @ApiProperty({
    type: GuardRunDetailView,
    nullable: true,
    description: 'The caller’s run under way.',
  })
  live: GuardRunDetailView | null;
  @ApiProperty({
    type: [GuardRunView],
    description:
      'At the caller’s post: scheduled runs whose window is open or opens within 12 hours, and those started today.',
  })
  runs: GuardRunView[];
  @ApiProperty({
    type: [BoardRouteView],
    description:
      'Routes in service from the caller’s post: a run of one may be started any time.',
  })
  routes: BoardRouteView[];
}
