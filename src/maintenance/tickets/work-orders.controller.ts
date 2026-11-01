import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CreateWorkOrderDto } from './dto/tickets.dto';
import { TicketCreatedView } from './views/ticket.views';
import { WorkOrdersService } from './work-orders.service';

/** The management's own work orders (ADR 0076), for `tickets.dispatch`. */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/work-orders')
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  /** Audited; dispatched like any repair once committed. */
  @Post()
  @ApiOperation({
    summary: 'Open a work order of the compound’s on an asset or a common area',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: TicketCreatedView })
  async create(@Body() dto: CreateWorkOrderDto): Promise<TicketCreatedView> {
    return TicketCreatedView.from(await this.workOrders.open(dto));
  }
}
