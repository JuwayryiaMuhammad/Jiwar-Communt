import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
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
import {
  AutoAssignmentView,
  DispatchAttemptView,
} from '../dispatch/views/attempt.views';
import { AvailabilityView } from '../dispatch/views/availability.views';
import { SpecialtyIdsDto } from '../specialties/dto/specialties.dto';
import { SpecialtiesService } from '../specialties/specialties.service';
import { SpecialtyRefView } from '../specialties/views/specialty.views';
import { ConfirmationService } from './confirmation.service';
import { DispatchService, type TechnicianOption } from './dispatch.service';
import { MessagesService } from './messages.service';
import {
  AssignDto,
  CategoryChangeDto,
  CreateTicketOnBehalfDto,
  DispatchTicketsQueryDto,
  PriorityDto,
  ReasonCodeDto,
  ReassignDto,
  StaffMessageDto,
} from './dto/tickets.dto';
import { SlaService } from '../sla/sla.service';
import { SlaEventView } from '../sla/views/sla.views';
import { TicketsService } from './tickets.service';
import {
  AssignmentView,
  DispatchTicketDetailView,
  DispatchTicketView,
  StatusHistoryView,
  TicketCreatedView,
} from './views/ticket.views';
import { DispatchMessageView, MessageCreatedView } from './views/message.views';

/**
 * Dispatch (ADR 0032): every ticket of the compound, for
 * `tickets.dispatch` (a maintenance supervisor, or the manager).
 */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/tickets')
export class DispatchTicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly dispatch: DispatchService,
    private readonly confirmation: ConfirmationService,
    private readonly messages: MessagesService,
    private readonly sla: SlaService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the compound's tickets" })
  @ApiOkResponse({ type: ListOf(DispatchTicketView) })
  async list(
    @Query() q: DispatchTicketsQueryDto,
  ): Promise<ListResponse<DispatchTicketView>> {
    return toList(
      await this.tickets.listForDispatch({
        ...q,
        unassigned: q.unassigned === 'true',
        open: q.open === 'true',
        overdue: q.overdue === 'true',
        escalated: q.escalated === 'true',
      }),
      (r) => DispatchTicketView.from(r),
    );
  }

  /** A ticket opened for a resident: audited, and the resident is told. */
  @Post()
  @ApiOperation({ summary: 'Open a ticket for a resident' })
  @Idempotent()
  @ApiCreatedResponse({ type: TicketCreatedView })
  async create(
    @Body() dto: CreateTicketOnBehalfDto,
  ): Promise<TicketCreatedView> {
    return TicketCreatedView.from(await this.tickets.createOnBehalf(dto));
  }

  /** No-store: the photos are presigned URLs. */
  @Get(':id')
  @ApiOperation({ summary: 'Get one ticket' })
  @NoStore()
  @ApiOkResponse({ type: DispatchTicketDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<DispatchTicketDetailView> {
    return DispatchTicketDetailView.fromDetail(
      await this.tickets.detail(id, 'dispatch'),
    );
  }

  @Get(':id/history')
  @ApiOperation({ summary: "Get a ticket's status history" })
  @ApiOkResponse({ type: ListOf(StatusHistoryView) })
  async history(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<StatusHistoryView>> {
    return bounded(
      StatusHistoryView.list(await this.tickets.statusHistory(id)),
      (r) => r,
    );
  }

  @Get(':id/assignments')
  @ApiOperation({ summary: "Get a ticket's assignments" })
  @ApiOkResponse({ type: ListOf(AssignmentView) })
  async assignments(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<AssignmentView>> {
    return bounded(
      AssignmentView.list(await this.tickets.assignments(id)),
      (r) => r,
    );
  }

  /** From the queue (`new`) to a technician. */
  @Post(':id/assign')
  @ApiOperation({ summary: 'Assign a queued ticket to a technician' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  assign(
    @Param('id', parseId()) id: string,
    @Body() dto: AssignDto,
  ): Promise<void> {
    return this.dispatch.assign(id, dto.technicianId);
  }

  /**
   * Runs the dispatch engine on the queued ticket now, even when automatic
   * dispatch is off (ADR 0033). `no_candidate` is an answer, not an error.
   */
  @Post(':id/auto-assign')
  @ApiOperation({ summary: 'Run the dispatch engine on a queued ticket now' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AutoAssignmentView })
  async autoAssign(
    @Param('id', parseId()) id: string,
  ): Promise<AutoAssignmentView> {
    return AutoAssignmentView.from(await this.dispatch.autoAssign(id));
  }

  /** Why the engine did what it did on this ticket, oldest first. */
  @Get(':id/dispatch-attempts')
  @ApiOperation({ summary: "Get the dispatch engine's attempts on a ticket" })
  @ApiOkResponse({ type: ListOf(DispatchAttemptView) })
  async dispatchAttempts(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<DispatchAttemptView>> {
    return bounded(
      DispatchAttemptView.list(await this.tickets.dispatchAttempts(id)),
      (r) => r,
    );
  }

  /** The ticket's SLA events, every cycle, oldest first (ADR 0034). */
  @Get(':id/sla-events')
  @ApiOperation({ summary: "Get a ticket's SLA events" })
  @ApiOkResponse({ type: ListOf(SlaEventView) })
  async slaEvents(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<SlaEventView>> {
    return bounded(await this.sla.events(id), (e) => SlaEventView.from(e));
  }

  /** `reasonCode` from the closed list `ticketReassign`. */
  @Post(':id/reassign')
  @ApiOperation({ summary: 'Reassign a ticket to another technician' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  reassign(
    @Param('id', parseId()) id: string,
    @Body() dto: ReassignDto,
  ): Promise<void> {
    return this.dispatch.reassign(id, dto.technicianId, dto.reasonCode);
  }

  /** `reasonCode` from the closed list `ticketPriority`; audited. */
  @Post(':id/priority')
  @ApiOperation({ summary: "Change a ticket's priority" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  priority(
    @Param('id', parseId()) id: string,
    @Body() dto: PriorityDto,
  ): Promise<void> {
    return this.dispatch.changePriority(id, dto.priority, dto.reasonCode);
  }

  /**
   * A dispatcher's correction (ADR 0034): `reasonCode` from
   * `ticketCategory`; audited. The technician keeps the ticket (the
   * dispatcher may reassign it), the engine does not run, and the SLA's
   * running clocks take the new category's targets.
   */
  @Post(':id/category')
  @ApiOperation({ summary: "Change a ticket's category" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  category(
    @Param('id', parseId()) id: string,
    @Body() dto: CategoryChangeDto,
  ): Promise<void> {
    return this.dispatch.changeCategory(id, dto.categoryId, dto.reasonCode);
  }

  /** Any time before it is closed; `reasonCode` from `ticketCancel`. */
  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a ticket' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.confirmation.cancelByDispatcher(id, dto.reasonCode);
  }

  /** A completed work order of the compound's, done well (ADR 0064). */
  @Post(':id/accept-work')
  @ApiOperation({ summary: 'Close a completed work order of the compound’s' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  acceptWork(@Param('id', parseId()) id: string): Promise<void> {
    return this.confirmation.acceptWork(id);
  }

  /**
   * A completed work order not done right (ADR 0064): `reasonCode` from
   * `ticketReject`; `reason` goes to the thread for the technician.
   */
  @Post(':id/send-back')
  @ApiOperation({ summary: 'Send a completed work order back' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  sendBack(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    return this.confirmation.sendBack(id, reasonOf(dto));
  }

  /** The thread, oldest first, internal messages included. */
  @Get(':id/messages')
  @ApiOperation({
    summary: "Read a ticket's thread, internal messages included",
  })
  @ApiOkResponse({ type: ListOf(DispatchMessageView) })
  async messagesOf(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<DispatchMessageView>> {
    return toList(await this.messages.list(id, 'dispatch', q), (m) =>
      DispatchMessageView.from(m),
    );
  }

  @Post(':id/messages')
  @ApiOperation({ summary: "Post to a ticket's thread" })
  @Idempotent()
  @ApiCreatedResponse({ type: MessageCreatedView })
  async post(
    @Param('id', parseId()) id: string,
    @Body() dto: StaffMessageDto,
  ): Promise<MessageCreatedView> {
    return MessageCreatedView.from(
      await this.messages.post(id, 'dispatch', dto.body, dto.internal),
    );
  }
}

export class TechnicianOptionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({
    type: Number,
    description: 'Tickets assigned, in progress or on hold.',
  })
  openTickets: number;
  @ApiProperty({
    type: [SpecialtyRefView],
    description: 'Their active specialties.',
  })
  specialties: SpecialtyRefView[];
  @ApiProperty({ type: AvailabilityView })
  availability: AvailabilityView;
  @ApiProperty({
    type: Number,
    description:
      'Weighted open work in points (two decimals): the sum over their assigned, in-progress and on-hold tickets of status weight × priority multiplier.',
  })
  workload: number;

  static from(t: TechnicianOption): TechnicianOptionView {
    return {
      id: t.id,
      fullName: t.fullName,
      openTickets: t.openTickets,
      specialties: t.specialties.map((s) => SpecialtyRefView.from(s)),
      availability: AvailabilityView.from(t.availability),
      workload: t.workload,
    };
  }
}

/** Who dispatch can assign to (ADR 0032). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/technicians')
export class TechniciansController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly specialties: SpecialtiesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the technicians dispatch can assign to' })
  @ApiOkResponse({ type: ListOf(TechnicianOptionView) })
  async list(): Promise<ListResponse<TechnicianOptionView>> {
    return bounded(await this.dispatch.technicians(), (t) =>
      TechnicianOptionView.from(t),
    );
  }

  /** The whole set, replacing the current one; empty clears it (audited). */
  @Put(':id/specialties')
  @ApiOperation({ summary: "Replace a technician's specialties" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  setSpecialties(
    @Param('id', parseId()) id: string,
    @Body() dto: SpecialtyIdsDto,
  ): Promise<void> {
    return this.specialties.setForTechnician(id, dto.specialtyIds);
  }
}
