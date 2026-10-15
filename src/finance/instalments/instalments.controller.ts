import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CancelInstalmentPlanDto,
  ConvertToInstalmentsDto,
  InstalmentPlansQueryDto,
} from './dto/instalments.dto';
import { InstalmentsService } from './instalments.service';
import {
  InstalmentPlanDetailView,
  InstalmentPlanView,
} from './views/instalment.views';

/** Instalment plans, for the staff who keep the invoices (ADR 0048). */
@ApiArea('finance')
@RequirePermissions('finance.invoice')
@Controller('staff')
export class StaffInstalmentsController {
  constructor(private readonly instalments: InstalmentsService) {}

  @Post('invoices/:id/instalment-plan')
  @ApiOperation({
    summary: 'Split what an invoice owes into instalments',
    description:
      'The instalments must add up to exactly what the invoice owes now; a credit note closes the original. One push tells the unit.',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: InstalmentPlanDetailView })
  convert(
    @Param('id', parseId()) id: string,
    @Body() dto: ConvertToInstalmentsDto,
  ): Promise<InstalmentPlanDetailView> {
    return this.instalments.convert(id, dto);
  }

  @Get('instalment-plans')
  @ApiOperation({ summary: 'List instalment plans, newest first' })
  @ApiOkResponse({ type: ListOf(InstalmentPlanView) })
  async list(
    @Query() q: InstalmentPlansQueryDto,
  ): Promise<ListResponse<InstalmentPlanView>> {
    return toList(await this.instalments.list(q), (v) => v);
  }

  @Get('instalment-plans/:id')
  @ApiOperation({ summary: 'Get an instalment plan with its instalments' })
  @ApiOkResponse({ type: InstalmentPlanDetailView })
  detail(
    @Param('id', parseId()) id: string,
  ): Promise<InstalmentPlanDetailView> {
    return this.instalments.detail(id);
  }

  @Post('instalment-plans/:id/cancel')
  @ApiOperation({
    summary: 'Cancel a plan: what its instalments owe becomes one invoice',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: InstalmentPlanDetailView })
  cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelInstalmentPlanDto,
  ): Promise<InstalmentPlanDetailView> {
    return this.instalments.cancel(id, dto);
  }
}

/** A unit's instalment plan, for whoever sees its money (ADR 0048). */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class UnitInstalmentsController {
  constructor(private readonly instalments: InstalmentsService) {}

  @Get('instalment-plans/:id')
  @ApiOperation({ summary: 'Get an instalment plan of one of my units' })
  @ApiOkResponse({ type: InstalmentPlanDetailView })
  detail(
    @Param('id', parseId()) id: string,
  ): Promise<InstalmentPlanDetailView> {
    return this.instalments.mine(id);
  }
}
