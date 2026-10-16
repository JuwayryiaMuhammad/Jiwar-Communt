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
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  GuardAttendanceQueryDto,
  CancelRosterSlotDto,
  CreateRosterSlotDto,
  CreateRosterTemplateDto,
  RosterRangeQueryDto,
  RosterSlotsQueryDto,
  RosterTemplatesQueryDto,
} from './dto/roster.dto';
import { RosterService } from './roster.service';
import {
  GuardAttendanceView,
  MySlotView,
  RosterGuardView,
  RosterPostsView,
  RosterSlotView,
  RosterTemplateView,
} from './views/roster.views';

const PERIOD =
  'The compound’s days `from` … `to`, inclusive (default today and the 13 after), 31 at most (PERIOD_TOO_LONG).';

/** The guards' roster, as the management keeps it (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('guard_roster.manage')
@Controller('staff/security')
export class StaffRosterController {
  constructor(private readonly roster: RosterService) {}

  @Get('posts')
  @NoStore()
  @ApiOperation({
    summary: 'List the posts a guard may be scheduled at',
    description: 'The gates and the zones (places) in service.',
  })
  @ApiOkResponse({ type: RosterPostsView })
  posts(): Promise<RosterPostsView> {
    return this.roster.posts();
  }

  @Get('guards')
  @NoStore()
  @ApiOperation({
    summary: 'List the guards the roster may schedule',
    description: 'Active accounts holding `gate.operate`.',
  })
  @ApiOkResponse({ type: ListOf(RosterGuardView) })
  async guards(): Promise<ListResponse<RosterGuardView>> {
    return bounded(await this.roster.guards(), (g) => g);
  }

  @Post('roster/templates')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Add a guard’s weekly roster at a post',
    description:
      'Its slots are made at once, 28 days ahead, and kept so. Never overlapping the guard’s other templates or slots (409 ROSTER_OVERLAP).',
  })
  @ApiCreatedResponse({ type: RosterTemplateView })
  createTemplate(
    @Body() dto: CreateRosterTemplateDto,
  ): Promise<RosterTemplateView> {
    return this.roster.createTemplate(dto);
  }

  @Get('roster/templates')
  @NoStore()
  @ApiOperation({ summary: 'List the roster templates' })
  @ApiOkResponse({ type: ListOf(RosterTemplateView) })
  async templates(
    @Query() q: RosterTemplatesQueryDto,
  ): Promise<ListResponse<RosterTemplateView>> {
    return bounded(await this.roster.templates(q), (t) => t);
  }

  @Post('roster/templates/:id/end')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End a roster template',
    description:
      'Its slots to come that nobody opened and no swap gave away are cancelled (`template_ended`).',
  })
  @ApiOkResponse({ type: RosterTemplateView })
  endTemplate(@Param('id', parseId()) id: string): Promise<RosterTemplateView> {
    return this.roster.endTemplate(id);
  }

  @Post('roster/slots')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Add a single slot',
    description:
      'In the future, a day at most; never overlapping the guard’s slots or templates (409 ROSTER_OVERLAP).',
  })
  @ApiCreatedResponse({ type: RosterSlotView })
  createSlot(@Body() dto: CreateRosterSlotDto): Promise<RosterSlotView> {
    return this.roster.createSlot(dto);
  }

  @Get('roster/slots')
  @NoStore()
  @ApiOperation({ summary: 'Read the roster', description: PERIOD })
  @ApiOkResponse({ type: ListOf(RosterSlotView) })
  async slots(
    @Query() q: RosterSlotsQueryDto,
  ): Promise<ListResponse<RosterSlotView>> {
    return bounded(await this.roster.slots(q), (s) => s);
  }

  @Post('roster/slots/:id/cancel')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a slot nobody opened',
    description: 'A filled or cancelled slot: 409 ROSTER_SLOT_CLOSED.',
  })
  @ApiOkResponse({ type: RosterSlotView })
  cancelSlot(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelRosterSlotDto,
  ): Promise<RosterSlotView> {
    return this.roster.cancelSlot(id, dto.reasonCode);
  }

  @Get('attendance')
  @NoStore()
  @ApiOperation({
    summary: 'Read the guards’ attendance and overtime',
    description: `${PERIOD} Recorded only: no payroll.`,
  })
  @ApiOkResponse({ type: ListOf(GuardAttendanceView) })
  async attendance(
    @Query() q: GuardAttendanceQueryDto,
  ): Promise<ListResponse<GuardAttendanceView>> {
    return bounded(await this.roster.attendance(q), (a) => a);
  }
}

/** A guard's own roster (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('gate.operate')
@Controller('gate/roster')
export class GuardRosterController {
  constructor(private readonly roster: RosterService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Read my schedule', description: PERIOD })
  @ApiOkResponse({ type: ListOf(MySlotView) })
  async mine(
    @Query() q: RosterRangeQueryDto,
  ): Promise<ListResponse<MySlotView>> {
    return bounded(await this.roster.mySlots(q), (s) => s);
  }

  @Get('attendance')
  @NoStore()
  @ApiOperation({ summary: 'Read my attendance', description: PERIOD })
  @ApiOkResponse({ type: GuardAttendanceView })
  attendance(@Query() q: RosterRangeQueryDto): Promise<GuardAttendanceView> {
    return this.roster.myAttendance(q);
  }
}
