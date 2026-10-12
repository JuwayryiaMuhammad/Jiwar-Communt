import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { RequestsService } from '../requests/requests.service';
import { AppointmentsService } from './appointments.service';
import {
  AppointmentSlotsQueryDto,
  CancelAppointmentByResidentDto,
  CancelAppointmentByStaffDto,
  SlotChoiceDto,
  StaffAppointmentsQueryDto,
} from './dto/appointments.dto';
import {
  AppointmentBookedView,
  AppointmentSlotView,
  StaffAppointmentSlotView,
} from './views/appointment.views';
import { StaffAppointmentListItemView } from '../requests/views/request.views';

/** The slots a resident may pick (ADR 0039). */
@ApiArea('management-requests')
@RequirePermissions('requests.create')
@Controller('management-appointment-slots')
export class ResidentAppointmentSlotsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /** A read, not a reservation: booking checks the slot again. */
  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the free appointment slots' })
  @ApiOkResponse({ type: ListOf(AppointmentSlotView) })
  async list(
    @Query() q: AppointmentSlotsQueryDto,
  ): Promise<ListResponse<AppointmentSlotView>> {
    return bounded(await this.appointments.slots(q), (s) =>
      AppointmentSlotView.from(s),
    );
  }
}

/** The author's side of an appointment: on their own request only. */
@ApiArea('management-requests')
@RequirePermissions('requests.create')
@Controller('management-requests')
export class ResidentAppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /**
   * Picks a slot for an appointment request: to move the appointment, or
   * to answer the management's proposal with another time. The pick waits
   * for the management.
   */
  @Post(':id/appointment')
  @NoStore()
  @ApiOperation({ summary: 'Pick a slot for my appointment' })
  @Idempotent()
  @ApiCreatedResponse({ type: AppointmentBookedView })
  async book(
    @Param('id', parseId()) id: string,
    @Body() dto: SlotChoiceDto,
  ): Promise<AppointmentBookedView> {
    return AppointmentBookedView.from(await this.appointments.book(id, dto));
  }

  @Post(':id/appointment/accept')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Accept the slot the management proposed' })
  @ApiNoContentResponse()
  async accept(@Param('id', parseId()) id: string): Promise<void> {
    await this.appointments.accept(id);
  }

  @Post(':id/appointment/cancel')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel my appointment' })
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelAppointmentByResidentDto,
  ): Promise<void> {
    await this.appointments.cancelByAuthor(id, dto.reasonCode);
  }
}

/** The compound's appointments, for whoever handles requests. */
@ApiArea('management-requests')
@RequirePermissions('requests.handle')
@Controller('management')
export class StaffAppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly requests: RequestsService,
  ) {}

  @Get('appointments')
  @NoStore()
  @ApiOperation({ summary: 'List the appointments, soonest first' })
  @ApiOkResponse({ type: ListOf(StaffAppointmentListItemView) })
  async list(
    @Query() q: StaffAppointmentsQueryDto,
  ): Promise<ListResponse<StaffAppointmentListItemView>> {
    return toList(await this.requests.appointmentsForStaff(q), (a) =>
      StaffAppointmentListItemView.fromRead(a),
    );
  }

  @Get('appointment-slots')
  @NoStore()
  @ApiOperation({
    summary: 'List the free appointment slots, with places left',
  })
  @ApiOkResponse({ type: ListOf(StaffAppointmentSlotView) })
  async slots(
    @Query() q: AppointmentSlotsQueryDto,
  ): Promise<ListResponse<StaffAppointmentSlotView>> {
    return bounded(await this.appointments.slots(q), (s) =>
      StaffAppointmentSlotView.fromOpen(s),
    );
  }

  /** A response: the request's clock stops. */
  @Post('requests/:id/appointment/confirm')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm the slot the resident picked' })
  @ApiNoContentResponse()
  async confirm(@Param('id', parseId()) id: string): Promise<void> {
    await this.appointments.confirm(id);
  }

  /**
   * Another slot instead of the resident's pick (a counter-proposal), or a
   * slot when the request has none. It waits for the resident. A response:
   * the request's clock stops.
   */
  @Post('requests/:id/appointment/propose')
  @NoStore()
  @ApiOperation({ summary: 'Propose a slot, or counter the resident’s pick' })
  @Idempotent()
  @ApiCreatedResponse({ type: AppointmentBookedView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: SlotChoiceDto,
  ): Promise<AppointmentBookedView> {
    return AppointmentBookedView.from(await this.appointments.propose(id, dto));
  }

  @Post('requests/:id/appointment/cancel')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel an appointment' })
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelAppointmentByStaffDto,
  ): Promise<void> {
    await this.appointments.cancelByStaff(id, dto.reasonCode);
  }
}
