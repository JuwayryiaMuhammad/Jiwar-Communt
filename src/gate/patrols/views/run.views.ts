import { ApiProperty } from '@nestjs/swagger';
import type {
  PatrolCheckpoint,
  PatrolNote,
  PatrolRoute,
  PatrolRouteVersion,
  PatrolRun,
  PatrolScan,
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
import type { PresignedReadView } from '../../../core/files/views/file.views';
import type { MediaView } from '../../media/gate-media';
import { CheckpointPositionView } from './checkpoint.views';
import {
  GuardStopNoteView,
  GuardStopScanView,
  StaffStopNoteView,
  StaffStopScanView,
} from './scan.views';

export interface RunContext {
  names: DutyNames;
  routes: Map<string, PatrolRoute>;
  versions: Map<string, PatrolRouteVersion>;
  /** Per version: its checkpoints in the order walked. */
  stops: Map<string, PatrolCheckpoint[]>;
  /** Per run: its scans by hand, flagged, and received after it ended. */
  counts: Map<string, { manual: number; suspect: number; late: number }>;
  /** Per run (details only): its scans. */
  scans: Map<string, PatrolScan[]>;
  /** Per scan (details only): its note. */
  notes: Map<string, PatrolNote>;
  /** Per note (details only): its photos' read URLs. */
  photos: Map<string, PresignedReadView[]>;
  /** Per note (details only): its recordings (ADR 0056). */
  media: Map<string, MediaView[]>;
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
  @ApiProperty({ type: Number, description: 'Scans by hand.' })
  manualScans: number;
  @ApiProperty({
    type: Number,
    description: 'Scans farther from their checkpoint than its radius.',
  })
  suspectScans: number;
  @ApiProperty({
    type: Number,
    description:
      'Scans that reached the server after the run ended: it was finished offline.',
  })
  lateScans: number;
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
    const counts = c.counts.get(r.id);
    return {
      ...body(r, c),
      guard: person(r.guardAccountId, c, accountRef),
      manualScans: counts?.manual ?? 0,
      suspectScans: counts?.suspect ?? 0,
      lateScans: counts?.late ?? 0,
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

/** A stop as the management reads it: the scan and the note there. */
export class StaffRunStopView extends RunStopView {
  @ApiProperty({ type: StaffStopScanView, nullable: true })
  scan: StaffStopScanView | null;
  @ApiProperty({ type: StaffStopNoteView, nullable: true })
  note: StaffStopNoteView | null;
}

/** A stop as a guard reads it: scanned or not; a note's outcome. */
export class GuardRunStopView extends RunStopView {
  @ApiProperty({ type: GuardStopScanView, nullable: true })
  scan: GuardStopScanView | null;
  @ApiProperty({ type: GuardStopNoteView, nullable: true })
  note: GuardStopNoteView | null;
}

/** The run's scan and note at each checkpoint of its version. */
function scanned(r: PatrolRun, c: RunContext, checkpointId: string) {
  const scan = (c.scans.get(r.id) ?? []).find(
    (sc) => sc.checkpointId === checkpointId,
  );
  const note = scan ? c.notes.get(scan.id) : undefined;
  return {
    scan: scan ?? null,
    note: note ?? null,
    photos: note ? (c.photos.get(note.id) ?? []) : [],
    media: note ? (c.media.get(note.id) ?? []) : [],
  };
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
  @ApiProperty({ type: [StaffRunStopView] })
  stops: StaffRunStopView[];

  static from(r: PatrolRun, c: RunContext): RunDetailView {
    const w = walk(r, c);
    return {
      ...RunView.of(r, c),
      ...w,
      stops: w.stops.map((stop) => {
        const at = scanned(r, c, stop.checkpointId);
        return {
          ...stop,
          scan: at.scan ? StaffStopScanView.from(at.scan, r) : null,
          note: at.note
            ? StaffStopNoteView.of(at.note, at.photos, at.media)
            : null,
        };
      }),
    };
  }
}

export class GuardRunDetailView extends GuardRunView {
  @ApiProperty({ type: Boolean })
  ordered: boolean;
  @ApiProperty({ type: Number })
  expectedMinutes: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  timesOutAt: Date | null;
  @ApiProperty({ type: [GuardRunStopView] })
  stops: GuardRunStopView[];

  /** `viewer`: the guard reading; a note's words and photos are its author's. */
  static forViewer(
    r: PatrolRun,
    c: RunContext,
    viewer: string,
  ): GuardRunDetailView {
    const w = walk(r, c);
    return {
      ...GuardRunView.from(r, c),
      ...w,
      stops: w.stops.map((stop) => {
        const at = scanned(r, c, stop.checkpointId);
        return {
          ...stop,
          scan: at.scan ? GuardStopScanView.of(at.scan) : null,
          note: at.note
            ? GuardStopNoteView.of(
                at.note,
                at.note.guardAccountId === viewer,
                at.photos,
                at.media,
              )
            : null,
        };
      }),
    };
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
