import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { TicketsService } from '../tickets/tickets.service';
import { TicketCreatedView } from '../tickets/views/ticket.views';
import { VisitSlotView } from '../visits/views/visit.views';
import { VisitsService } from '../visits/visits.service';
import {
  CreatePreventiveRequestDto,
  PreventiveSlotsQueryDto,
} from './dto/preventive-requests.dto';

/**
 * A resident books a check-up (ADR 0038): `tickets.create`, and the
 * `tickets` capability on the unit, as for any ticket.
 */
@ApiArea('tickets')
@RequirePermissions('tickets.create')
@Controller()
export class PreventiveRequestsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly visits: VisitsService,
  ) {}

  /**
   * A ticket of kind `preventive`, under the service's category. When a
   * technician takes it, the window is proposed to them as a visit.
   */
  @Post('tickets/preventive')
  @Idempotent()
  @ApiCreatedResponse({ type: TicketCreatedView })
  async create(
    @Body() dto: CreatePreventiveRequestDto,
  ): Promise<TicketCreatedView> {
    return TicketCreatedView.from(await this.tickets.createPreventive(dto));
  }

  /**
   * The windows a request may ask for: the compound's visiting hours cut
   * into slots, 15 minutes to 30 days ahead. Not a reservation. No-store
   * like every visit read.
   */
  @Get('preventive-slots')
  @NoStore()
  @ApiOkResponse({ type: ListOf(VisitSlotView) })
  async slots(
    @Query() q: PreventiveSlotsQueryDto,
  ): Promise<ListResponse<VisitSlotView>> {
    return bounded(await this.visits.requestSlots(q.unitId, q), (s) =>
      VisitSlotView.from(s),
    );
  }
}
