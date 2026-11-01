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
import { PlaceView } from '../places/views/place.views';
import { DutyRosterService } from './duty-roster.service';
import {
  CreateDutySlotDto,
  CreateDutyTemplateDto,
  DutySlotsQueryDto,
  DutyTemplatesQueryDto,
  TechnicianAttendanceQueryDto,
} from './dto/duty-roster.dto';
import { CancelRosterSlotDto, RosterRangeQueryDto } from './dto/roster.dto';
import {
  DutySlotView,
  DutyTemplateView,
  MyDutySlotView,
  RosterGuardView,
  TechnicianAttendanceView,
} from './views/roster.views';

const PERIOD =
  'The compound’s days `from` … `to`, inclusive (default today and the 13 after), 31 at most (PERIOD_TOO_LONG).';

/**
 * The technicians' roster, as the field team keeps it (ADR 0078): the
 * guards' roster for the maintenance crew. A post is a zone or none.
 */
@ApiArea('field-team')
@RequirePermissions('field_team.manage')
@Controller('staff/field-team')
export class StaffDutyRosterController {
  constructor(private readonly roster: DutyRosterService) {}

  @Get('technicians')
  @NoStore()
  @ApiOperation({
    summary: 'List the technicians the roster may schedule',
    description: 'Active accounts holding `tickets.work`.',
  })
  @ApiOkResponse({ type: ListOf(RosterGuardView) })
  async technicians(): Promise<ListResponse<RosterGuardView>> {
    return bounded(await this.roster.technicians(), (t) => t);
  }

  @Get('zones')
  @NoStore()
  @ApiOperation({ summary: 'List the zones a technician may cover' })
  @ApiOkResponse({ type: ListOf(PlaceView) })
  async zones(): Promise<ListResponse<PlaceView>> {
    return bounded(await this.roster.zones(), (z) => z);
  }

  @Post('roster/templates')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Add a technician’s weekly roster',
    description:
      'In a zone or for the whole compound. Its slots are made at once, 28 days ahead, and kept so; never overlapping the technician’s other templates or slots (409 ROSTER_OVERLAP).',
  })
  @ApiCreatedResponse({ type: DutyTemplateView })
  createTemplate(
    @Body() dto: CreateDutyTemplateDto,
  ): Promise<DutyTemplateView> {
    return this.roster.createTemplate(dto);
  }

  @Get('roster/templates')
  @NoStore()
  @ApiOperation({ summary: 'List the technicians’ roster templates' })
  @ApiOkResponse({ type: ListOf(DutyTemplateView) })
  async templates(
    @Query() q: DutyTemplatesQueryDto,
  ): Promise<ListResponse<DutyTemplateView>> {
    return bounded(await this.roster.templates(q), (t) => t);
  }

  @Post('roster/templates/:id/end')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End a technician’s roster template',
    description:
      'Its slots to come that nobody filled are cancelled (`template_ended`).',
  })
  @ApiOkResponse({ type: DutyTemplateView })
  endTemplate(@Param('id', parseId()) id: string): Promise<DutyTemplateView> {
    return this.roster.endTemplate(id);
  }

  @Post('roster/slots')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Add a technician’s single slot',
    description:
      'In the future, a day at most; never overlapping their slots or templates (409 ROSTER_OVERLAP). Filled at once when they are on duty and it starts within the half hour.',
  })
  @ApiCreatedResponse({ type: DutySlotView })
  createSlot(@Body() dto: CreateDutySlotDto): Promise<DutySlotView> {
    return this.roster.createSlot(dto);
  }

  @Get('roster/slots')
  @NoStore()
  @ApiOperation({
    summary: 'Read the technicians’ roster',
    description: PERIOD,
  })
  @ApiOkResponse({ type: ListOf(DutySlotView) })
  async slots(
    @Query() q: DutySlotsQueryDto,
  ): Promise<ListResponse<DutySlotView>> {
    return bounded(await this.roster.slots(q), (s) => s);
  }

  @Post('roster/slots/:id/cancel')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a technician’s slot nobody filled',
    description: 'A filled or cancelled slot: 409 ROSTER_SLOT_CLOSED.',
  })
  @ApiOkResponse({ type: DutySlotView })
  cancelSlot(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelRosterSlotDto,
  ): Promise<DutySlotView> {
    return this.roster.cancelSlot(id, dto.reasonCode);
  }

  @Get('attendance')
  @NoStore()
  @ApiOperation({
    summary: 'Read the technicians’ attendance and overtime',
    description: `${PERIOD} Recorded only: no payroll.`,
  })
  @ApiOkResponse({ type: ListOf(TechnicianAttendanceView) })
  async attendance(
    @Query() q: TechnicianAttendanceQueryDto,
  ): Promise<ListResponse<TechnicianAttendanceView>> {
    return bounded(await this.roster.attendance(q), (a) => a);
  }
}

/** A technician's own roster (ADR 0078). */
@ApiArea('field-team')
@RequirePermissions('tickets.work')
@Controller('maintenance/my-roster')
export class TechnicianRosterController {
  constructor(private readonly roster: DutyRosterService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Read my schedule', description: PERIOD })
  @ApiOkResponse({ type: ListOf(MyDutySlotView) })
  async mine(
    @Query() q: RosterRangeQueryDto,
  ): Promise<ListResponse<MyDutySlotView>> {
    return bounded(await this.roster.mySlots(q), (s) => s);
  }

  @Get('attendance')
  @NoStore()
  @ApiOperation({ summary: 'Read my attendance', description: PERIOD })
  @ApiOkResponse({ type: TechnicianAttendanceView })
  attendance(
    @Query() q: RosterRangeQueryDto,
  ): Promise<TechnicianAttendanceView> {
    return this.roster.myAttendance(q);
  }
}
