import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import { RecordCostDto } from './dto/costs.dto';
import { TicketCostsService } from './ticket-costs.service';
import { TicketCostEntryView, TicketCostsView } from './views/cost.views';

/** A ticket's costs for dispatch (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance')
export class TicketCostsController {
  constructor(private readonly costs: TicketCostsService) {}

  @Get('tickets/:id/costs')
  @ApiOperation({ summary: 'List a ticket’s costs and their totals' })
  @ApiOkResponse({ type: TicketCostsView })
  async list(@Param('id', parseId()) id: string): Promise<TicketCostsView> {
    return TicketCostsView.from(await this.costs.list(id));
  }

  @Post('tickets/:id/costs')
  @Idempotent()
  @ApiOperation({ summary: 'Record labour, a contractor or another cost' })
  @ApiCreatedResponse({ type: TicketCostEntryView })
  async record(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordCostDto,
  ): Promise<TicketCostEntryView> {
    return TicketCostEntryView.from(await this.costs.record(id, dto));
  }

  /** `reasonCode` from the closed list `ticketCostVoid`; a part's entry never. */
  @Post('ticket-costs/:id/void')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Void a cost entry, once' })
  @ApiOkResponse({ type: TicketCostEntryView })
  async void(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<TicketCostEntryView> {
    return TicketCostEntryView.from(await this.costs.void(id, dto.reasonCode));
  }
}
