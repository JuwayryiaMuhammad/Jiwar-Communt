import { ApiProperty } from '@nestjs/swagger';
import type {
  PatrolCheckpoint,
  PatrolRoute,
  PatrolRouteVersion,
} from '@prisma/client';
import type { DutyNames } from '../../roster/duty-names';
import { PostView } from '../../roster/views/roster.views';
import { scheduleOf, windowMinutes } from '../patrol-rules';
import { CheckpointPositionView } from './checkpoint.views';

export class PatrolScheduleView {
  @ApiProperty({ type: [Number], example: [0, 1, 2, 3, 4] })
  days: number[];
  @ApiProperty({ type: [String], example: ['08:00', '22:00'] })
  times: string[];
}

/** What a route asks now: its current version. */
export class RouteVersionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number, description: '1 for the first, then up.' })
  number: number;
  @ApiProperty({ type: Boolean })
  ordered: boolean;
  @ApiProperty({ type: Number })
  expectedMinutes: number;
  @ApiProperty({
    type: Number,
    description:
      'How long a scheduled run may be started for, from its start: the expected minutes, 30 at least.',
  })
  windowMinutes: number;
  @ApiProperty({ type: PatrolScheduleView, nullable: true })
  schedule: PatrolScheduleView | null;
  @ApiProperty({ type: Number, description: 'How many checkpoints.' })
  checkpoints: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static of(v: PatrolRouteVersion, checkpoints: number): RouteVersionView {
    return {
      id: v.id,
      number: v.number,
      ordered: v.ordered,
      expectedMinutes: v.expectedMinutes,
      windowMinutes: windowMinutes(v.expectedMinutes),
      schedule: scheduleOf(v.schedule),
      checkpoints,
      createdAt: v.createdAt,
    };
  }
}

export interface RouteContext {
  names: DutyNames;
  /** Per route: its current version. */
  versions: Map<string, PatrolRouteVersion>;
  /** Per version: its checkpoints in order. */
  stops: Map<string, PatrolCheckpoint[]>;
}

/** A route as the management keeps it (ADR 0052). */
export class RouteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: String, example: 'Night perimeter' })
  nameEn: string;
  @ApiProperty({ type: String, example: 'جولة السور الليلية' })
  nameAr: string;
  @ApiProperty({ type: RouteVersionView })
  version: RouteVersionView;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static of(r: PatrolRoute, c: RouteContext): RouteView {
    const version = c.versions.get(r.id)!;
    return {
      id: r.id,
      post: PostView.of(r, c.names),
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      version: RouteVersionView.of(
        version,
        c.stops.get(version.id)?.length ?? 0,
      ),
      retiredAt: r.retiredAt,
      createdAt: r.createdAt,
    };
  }
}

/** A checkpoint of a route, at its place in the walk. */
export class RouteStopView {
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
  @ApiProperty({
    type: Boolean,
    description: 'Retired since: a new version must leave it out.',
  })
  retired: boolean;

  static of(c: PatrolCheckpoint, position: number): RouteStopView {
    return {
      position,
      checkpointId: c.id,
      nameEn: c.nameEn,
      nameAr: c.nameAr,
      location: CheckpointPositionView.of(c),
      retired: c.retiredAt !== null,
    };
  }
}

export class RouteDetailView extends RouteView {
  @ApiProperty({ type: [RouteStopView] })
  stops: RouteStopView[];

  static from(r: PatrolRoute, c: RouteContext): RouteDetailView {
    const view = RouteView.of(r, c);
    return {
      ...view,
      stops: (c.stops.get(view.version.id) ?? []).map((cp, i) =>
        RouteStopView.of(cp, i + 1),
      ),
    };
  }
}
