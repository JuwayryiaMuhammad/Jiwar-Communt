import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CancelRunDto, RunsQueryDto } from './dto/runs.dto';
import { NoteDto, ScanDto } from './dto/scans.dto';
import { TrackDto } from './dto/track.dto';
import { GuardPatrolsService } from './guard-patrols.service';
import { PatrolScansService } from './patrol-scans.service';
import { PatrolTrackService } from './patrol-track.service';
import { StaffRunsService } from './staff-runs.service';
import {
  GuardRunDetailView,
  GuardRunView,
  PatrolBoardView,
  RunDetailView,
  RunView,
} from './views/run.views';
import { NoteView, ScanView } from './views/scan.views';
import {
  GeofenceExitView,
  TrackAcceptedView,
  TrackPointView,
} from './views/track.views';

/** A guard's patrols (ADR 0052), inside a shift. */
@ApiArea('patrols')
@RequirePermissions('gate.operate')
@Controller('gate/patrols')
export class GuardPatrolsController {
  constructor(
    private readonly patrols: GuardPatrolsService,
    private readonly scans: PatrolScansService,
    private readonly track: PatrolTrackService,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'My patrols at my post',
    description:
      'On shift (403 NO_OPEN_SHIFT): my run under way, the post’s runs to start or started today, and its routes.',
  })
  @ApiOkResponse({ type: PatrolBoardView })
  board(): Promise<PatrolBoardView> {
    return this.patrols.board();
  }

  @Get('runs')
  @NoStore()
  @ApiOperation({ summary: 'The runs I started', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(GuardRunView) })
  async mine(@Query() q: PageQueryDto): Promise<ListResponse<GuardRunView>> {
    return toList(await this.patrols.mine(q), (r) => r);
  }

  @Get('runs/:id')
  @NoStore()
  @ApiOperation({
    summary: 'A run and its checkpoints',
    description: 'Mine, or one of the post where I am on shift.',
  })
  @ApiOkResponse({ type: GuardRunDetailView })
  detail(@Param('id', parseId()) id: string): Promise<GuardRunDetailView> {
    return this.patrols.detail(id);
  }

  @Post('runs/:id/start')
  @NoStore()
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a scheduled run',
    description:
      'At my post, from 15 minutes before its start until its window ends (409 PATROL_RUN_NOT_STARTABLE, params.reason). The first start wins (409 PATROL_ALREADY_STARTED); one run under way per guard (409 PATROL_RUN_ALREADY_LIVE).',
  })
  @ApiOkResponse({ type: GuardRunDetailView })
  start(@Param('id', parseId()) id: string): Promise<GuardRunDetailView> {
    return this.patrols.start(id);
  }

  @Post('routes/:id/start')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Start a run of my own',
    description:
      'Of a route in service from my post, on its current version. One run under way per guard (409 PATROL_RUN_ALREADY_LIVE).',
  })
  @ApiCreatedResponse({ type: GuardRunDetailView })
  startAdhoc(@Param('id', parseId()) id: string): Promise<GuardRunDetailView> {
    return this.patrols.startAdhoc(id);
  }

  @Post('runs/:id/scans')
  @NoStore()
  @ApiOperation({
    summary: 'Scan a checkpoint',
    description:
      'Of my run: its QR or NFC payload, or by hand with a `patrolManualScan` code. The app’s own id records once (offline, a retry); the device’s time must fall in the run’s lifetime. An ordered route takes its checkpoints in order (422 PATROL_OUT_OF_ORDER, params.expected); each once (409 PATROL_CHECKPOINT_ALREADY_SCANNED). Farther than the checkpoint’s radius is kept and flagged. The last one completes the run.',
  })
  @ApiCreatedResponse({ type: ScanView })
  scan(
    @Param('id', parseId()) id: string,
    @Body() dto: ScanDto,
  ): Promise<ScanView> {
    return this.scans.scan(id, dto);
  }

  @Post('runs/:id/notes')
  @NoStore()
  @ApiOperation({
    summary: 'Note what I found at a checkpoint',
    description:
      'At a scan of my run, one each (409 PATROL_NOTE_EXISTS): an outcome, words, up to three `patrol_photo` files. Under way, or up to 30 minutes after it ended.',
  })
  @ApiCreatedResponse({ type: NoteView })
  note(
    @Param('id', parseId()) id: string,
    @Body() dto: NoteDto,
  ): Promise<NoteView> {
    return this.scans.note(id, dto);
  }

  @Post('runs/:id/track')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send where I walked',
    description:
      'Up to 100 points of my run, under way or up to 30 minutes after it ended (409 PATROL_RUN_NOT_LIVE). A point outside the run’s lifetime is dropped (`rejected`), a point already sent adds nothing; the rest are kept (`accepted`).',
  })
  @ApiOkResponse({ type: TrackAcceptedView })
  record(
    @Param('id', parseId()) id: string,
    @Body() dto: TrackDto,
  ): Promise<TrackAcceptedView> {
    return this.track.record(id, dto.points);
  }

  @Get('runs/:id/track')
  @NoStore()
  @ApiOperation({
    summary: 'Where I walked on my run',
    description: 'My own runs only; kept 30 days.',
  })
  @ApiOkResponse({ type: ListOf(TrackPointView) })
  async myTrack(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<TrackPointView>> {
    return bounded(await this.track.mine(id), (p) => p);
  }

  @Post('runs/:id/end')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End my run',
    description:
      'Completed when every checkpoint was scanned, else incomplete: the roster’s keepers are told. Under way only (409 PATROL_RUN_NOT_LIVE).',
  })
  @ApiOkResponse({ type: GuardRunDetailView })
  end(@Param('id', parseId()) id: string): Promise<GuardRunDetailView> {
    return this.patrols.end(id);
  }
}

/** The runs as the management reads them (ADR 0052). */
@ApiArea('patrols')
@Controller('staff/security/patrols/runs')
export class StaffRunsController {
  constructor(
    private readonly runs: StaffRunsService,
    private readonly track: PatrolTrackService,
  ) {}

  @Get()
  @NoStore()
  @RequireAnyPermission('patrols.manage', 'guard_reports.read')
  @ApiOperation({
    summary: 'List the runs',
    description: 'Planned on the compound’s days asked, newest first.',
  })
  @ApiOkResponse({ type: ListOf(RunView) })
  async list(@Query() q: RunsQueryDto): Promise<ListResponse<RunView>> {
    return toList(await this.runs.list(q), (r) => r);
  }

  @Get(':id')
  @NoStore()
  @RequireAnyPermission('patrols.manage', 'guard_reports.read')
  @ApiOperation({ summary: 'Get a run' })
  @ApiOkResponse({ type: RunDetailView })
  detail(@Param('id', parseId()) id: string): Promise<RunDetailView> {
    return this.runs.detail(id);
  }

  @Get(':id/track')
  @NoStore()
  @RequirePermissions('patrols.manage')
  @ApiOperation({
    summary: 'Where the guard walked',
    description: 'The guard’s location: `patrols.manage` only, kept 30 days.',
  })
  @ApiOkResponse({ type: ListOf(TrackPointView) })
  async runTrack(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<TrackPointView>> {
    return bounded(await this.track.forStaff(id), (p) => p);
  }

  @Get(':id/geofence-exits')
  @NoStore()
  @RequirePermissions('patrols.manage')
  @ApiOperation({
    summary: 'When the guard left the route’s geofence',
    description:
      'ADR 0056: each time outside, oldest first, with when it was flagged — times only, never where. `patrols.manage` only.',
  })
  @ApiOkResponse({ type: ListOf(GeofenceExitView) })
  async geofenceExits(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<GeofenceExitView>> {
    return bounded(await this.track.exitsForStaff(id), (e) => e);
  }

  @Post(':id/cancel')
  @NoStore()
  @RequirePermissions('patrols.manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a scheduled run',
    description:
      'Nobody started it yet (409 PATROL_RUN_CLOSED, params.status); a `patrolRunCancel` code.',
  })
  @ApiOkResponse({ type: RunView })
  cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelRunDto,
  ): Promise<RunView> {
    return this.runs.cancel(id, dto.reasonCode);
  }
}
