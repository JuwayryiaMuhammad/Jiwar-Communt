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
  ) {}

  @Get()
  @ApiOkResponse({ type: ListOf(DispatchTicketView) })
  async list(
    @Query() q: DispatchTicketsQueryDto,
  ): Promise<ListResponse<DispatchTicketView>> {
    return toList(
      await this.tickets.listForDispatch({
        ...q,
        unassigned: q.unassigned === 'true',
      }),
      (r) => DispatchTicketView.from(r),
    );
  }

  /** A ticket opened for a resident: audited, and the resident is told. */
  @Post()
  @Idempotent()
  @ApiCreatedResponse({ type: TicketCreatedView })
  async create(
    @Body() dto: CreateTicketOnBehalfDto,
  ): Promise<TicketCreatedView> {
    return TicketCreatedView.from(await this.tickets.createOnBehalf(dto));
  }

  /** No-store: the photos are presigned URLs. */
  @Get(':id')
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
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AutoAssignmentView })
  async autoAssign(
    @Param('id', parseId()) id: string,
  ): Promise<AutoAssignmentView> {
    return AutoAssignmentView.from(await this.dispatch.autoAssign(id));
  }

  /** Why the engine did what it did on this ticket, oldest first. */
  @Get(':id/dispatch-attempts')
  @ApiOkResponse({ type: ListOf(DispatchAttemptView) })
  async dispatchAttempts(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<DispatchAttemptView>> {
    return bounded(
      DispatchAttemptView.list(await this.tickets.dispatchAttempts(id)),
      (r) => r,
    );
  }

  /** `reasonCode` from the closed list `ticketReassign`. */
  @Post(':id/reassign')
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.confirmation.cancelByDispatcher(id, dto.reasonCode);
  }

  /** The thread, oldest first, internal messages included. */
  @Get(':id/messages')
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
  @ApiOkResponse({ type: ListOf(TechnicianOptionView) })
  async list(): Promise<ListResponse<TechnicianOptionView>> {
    return bounded(await this.dispatch.technicians(), (t) =>
      TechnicianOptionView.from(t),
    );
  }

  /** The whole set, replacing the current one; empty clears it (audited). */
  @Put(':id/specialties')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  setSpecialties(
    @Param('id', parseId()) id: string,
    @Body() dto: SpecialtyIdsDto,
  ): Promise<void> {
    return this.specialties.setForTechnician(id, dto.specialtyIds);
  }
}
