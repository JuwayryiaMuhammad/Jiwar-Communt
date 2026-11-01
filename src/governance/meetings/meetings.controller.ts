import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  AddActionDto,
  CompleteActionDto,
  HoldMeetingDto,
  LinkMinutesDto,
  MeetingActionsQueryDto,
  MeetingsQueryDto,
  ScheduleMeetingDto,
  UpdateMeetingDto,
} from './meetings.dto';
import { MeetingsService } from './meetings.service';
import {
  MeetingActionView,
  MeetingDetailView,
  MeetingView,
} from './meetings.views';

const WHO =
  'A sitting member of the board (BOARD_SEAT_REQUIRED) or the manager; a member acts on their own board’s meetings (BOARD_MEETING_BOARD_GONE).';

/** Board meetings: their agenda, attendance, minutes and action items (ADR 0075). */
@ApiArea('governance')
@RequireAnyPermission('governance.board', 'governance.manage')
@Controller('board/meetings')
export class BoardMeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'The board’s meetings, latest first' })
  @ApiOkResponse({ type: ListOf(MeetingView) })
  async list(@Query() q: MeetingsQueryDto): Promise<ListResponse<MeetingView>> {
    return toList(await this.meetings.list(q), (m) => MeetingView.from(m));
  }

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Schedule a meeting of the board that sits',
    description: `${WHO} With no board sitting: BOARD_NOT_SITTING. Its agenda names pending requests, pending appeals and open agenda proposals (INVALID_VALUE otherwise), or items in the board’s own words. The other sitting members are told.`,
  })
  @ApiCreatedResponse({ type: MeetingDetailView })
  async schedule(@Body() dto: ScheduleMeetingDto): Promise<MeetingDetailView> {
    return MeetingDetailView.fromRecord(await this.meetings.schedule(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Read a meeting',
    description:
      'Its agenda, who was there once held, its action items, and the open items of the same board’s earlier meetings.',
  })
  @ApiOkResponse({ type: MeetingDetailView })
  async get(@Param('id', parseId()) id: string): Promise<MeetingDetailView> {
    return MeetingDetailView.fromRecord(await this.meetings.get(id));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Change a scheduled meeting',
    description: `${WHO} While scheduled (BOARD_MEETING_NOT_SCHEDULED); an agenda given replaces the one it had.`,
  })
  @ApiOkResponse({ type: MeetingDetailView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateMeetingDto,
  ): Promise<MeetingDetailView> {
    return MeetingDetailView.fromRecord(await this.meetings.update(id, dto));
  }

  @Post(':id/hold')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Record a meeting held',
    description: `${WHO} Once: who of the seats sitting now was present; whether that was more than half (quorate).`,
  })
  @ApiOkResponse({ type: MeetingDetailView })
  async hold(
    @Param('id', parseId()) id: string,
    @Body() dto: HoldMeetingDto,
  ): Promise<MeetingDetailView> {
    return MeetingDetailView.fromRecord(await this.meetings.hold(id, dto));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Call off a scheduled meeting',
    description: `${WHO} Once, with a code from \`boardMeetingCancel\`. The other sitting members are told.`,
  })
  @ApiOkResponse({ type: MeetingDetailView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MeetingDetailView> {
    return MeetingDetailView.fromRecord(await this.meetings.cancel(id, dto));
  }

  @Post(':id/minutes')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Link a held meeting’s minutes',
    description:
      'Once (BOARD_MEETING_MINUTES_LINKED), after it was held (BOARD_MEETING_NOT_HELD): a board publication of kind `minutes` of the same board, published to the owners as ADR 0051 says.',
  })
  @ApiOkResponse({ type: MeetingDetailView })
  async minutes(
    @Param('id', parseId()) id: string,
    @Body() dto: LinkMinutesDto,
  ): Promise<MeetingDetailView> {
    return MeetingDetailView.fromRecord(
      await this.meetings.linkMinutes(id, dto),
    );
  }

  @Post(':id/actions')
  @NoStore()
  @ApiOperation({
    summary: 'Add an action item to a held meeting',
    description:
      'Its owner (a sitting member of the meeting’s board or an active manager) is told, and told once more when it runs past its day.',
  })
  @ApiCreatedResponse({ type: MeetingActionView })
  async addAction(
    @Param('id', parseId()) id: string,
    @Body() dto: AddActionDto,
  ): Promise<MeetingActionView> {
    return MeetingActionView.from(await this.meetings.addAction(id, dto));
  }
}

/** The board's action items across meetings (ADR 0075). */
@ApiArea('governance')
@RequireAnyPermission('governance.board', 'governance.manage')
@Controller('board/meeting-actions')
export class BoardMeetingActionsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Action items, newest first',
    description:
      'Open ones to follow up (`status=open`), or the caller’s own (`mine=true`).',
  })
  @ApiOkResponse({ type: ListOf(MeetingActionView) })
  async list(
    @Query() q: MeetingActionsQueryDto,
  ): Promise<ListResponse<MeetingActionView>> {
    return toList(await this.meetings.actions(q), (a) =>
      MeetingActionView.from(a),
    );
  }

  @Post(':id/done')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Mark an action item done',
    description:
      'Its owner, a sitting member or the manager (BOARD_MEETING_ACTION_NOT_YOURS); once (BOARD_MEETING_ACTION_CLOSED).',
  })
  @ApiOkResponse({ type: MeetingActionView })
  async done(
    @Param('id', parseId()) id: string,
    @Body() dto: CompleteActionDto,
  ): Promise<MeetingActionView> {
    return MeetingActionView.from(await this.meetings.completeAction(id, dto));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel an action item',
    description: `${WHO} Once, with a code from \`boardActionCancel\`.`,
  })
  @ApiOkResponse({ type: MeetingActionView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MeetingActionView> {
    return MeetingActionView.from(await this.meetings.cancelAction(id, dto));
  }
}
