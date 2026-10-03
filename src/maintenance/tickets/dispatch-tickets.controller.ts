import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
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
import {
  CreateTicketOnBehalfDto,
  DispatchTicketsQueryDto,
} from './dto/tickets.dto';
import { TicketsService } from './tickets.service';
import {
  AssignmentView,
  DispatchTicketDetailView,
  DispatchTicketView,
  StatusHistoryView,
  TicketCreatedView,
} from './views/ticket.views';

/**
 * Dispatch (ADR 0032): every ticket of the compound, for
 * `tickets.dispatch` (a maintenance supervisor, or the manager).
 */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/tickets')
export class DispatchTicketsController {
  constructor(private readonly tickets: TicketsService) {}

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
}
