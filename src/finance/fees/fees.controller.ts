import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { FeesService, type InvoiceComparison } from './fees.service';
import { InvoiceComparisonView, UnitFeeView } from './views/fee.views';

/**
 * Fee transparency (ADR 0069), for whoever sees the unit's money
 * (capabilities.financeView): its owners, its tenants, members the primary
 * gave `finance`.
 */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get('units/:unitId/fees')
  @ApiOperation({
    summary: 'List a unit’s recurring fees: what each pays for and its changes',
  })
  @ApiOkResponse({ type: ListOf(UnitFeeView) })
  async forUnit(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<UnitFeeView>> {
    return bounded(await this.fees.forUnit(unitId), (f) => f);
  }

  @Get('invoices/:id/comparison')
  @ApiOperation({
    summary: 'Compare one of my units’ invoices with the one before it',
  })
  @ApiOkResponse({ type: InvoiceComparisonView })
  comparison(@Param('id', parseId()) id: string): Promise<InvoiceComparison> {
    return this.fees.comparison(id);
  }
}
