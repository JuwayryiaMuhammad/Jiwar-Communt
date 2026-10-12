import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { TicketsService } from './tickets.service';

/** Someone a ticket may be opened for: an id and a name, nothing else. */
export class TicketReporterView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
}

/**
 * What dispatch reads about a unit to open a ticket for one of its people
 * (ADR 0032). It names residents, so `tickets.dispatch` alone is not
 * enough: the caller also holds `residents.read`.
 */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch', 'residents.read')
@Controller('maintenance/units')
export class DispatchUnitsController {
  constructor(private readonly tickets: TicketsService) {}

  /**
   * The unit's occupants and the household members with an account who
   * hold `tickets`: exactly whom `POST /maintenance/tickets` accepts as
   * `reporterAccountId` there.
   */
  @Get(':unitId/reporters')
  @ApiOperation({ summary: 'List who a ticket may be opened for in a unit' })
  @ApiOkResponse({ type: ListOf(TicketReporterView) })
  async reporters(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<TicketReporterView>> {
    return bounded(await this.tickets.reportersOf(unitId), (r) => ({
      id: r.id,
      fullName: r.fullName,
    }));
  }
}
