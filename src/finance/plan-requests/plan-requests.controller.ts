import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ConvertToInstalmentsDto } from '../instalments/dto/instalments.dto';
import {
  AskPlanDto,
  DeclinePlanRequestDto,
  PlanRequestQueueDto,
  PlanSettingsDto,
} from './dto/plan-requests.dto';
import {
  PlanRequestsService,
  type PlanRequestRead,
} from './plan-requests.service';
import {
  PlanSettingsService,
  type PlanSettings,
} from './plan-settings.service';
import { PlanRequestView, PlanSettingsView } from './views/plan-request.views';

/**
 * A payment plan asked for by whoever pays the unit's money (ADR 0069,
 * capabilities.financePay); its requester withdraws it.
 */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class PlanRequestsController {
  constructor(private readonly requests: PlanRequestsService) {}

  @Post('invoices/:id/plan-requests')
  @Idempotent()
  @ApiOperation({ summary: 'Ask for a payment plan on one of my invoices' })
  @ApiCreatedResponse({ type: PlanRequestView })
  ask(
    @Param('id', parseId()) id: string,
    @Body() dto: AskPlanDto,
  ): Promise<PlanRequestRead> {
    return this.requests.ask(id, dto.months);
  }

  @Get('plan-requests/:id')
  @ApiOperation({ summary: 'Get a payment plan request of my unit' })
  @ApiOkResponse({ type: PlanRequestView })
  get(@Param('id', parseId()) id: string): Promise<PlanRequestRead> {
    return this.requests.mine(id);
  }

  @Post('plan-requests/:id/withdraw')
  @ApiOperation({ summary: 'Withdraw my payment plan request while it waits' })
  @ApiCreatedResponse({ type: PlanRequestView })
  withdraw(@Param('id', parseId()) id: string): Promise<PlanRequestRead> {
    return this.requests.withdraw(id);
  }
}

/** The residents' plan requests, for the finance staff (`finance.invoice`). */
@ApiArea('finance')
@RequirePermissions('finance.invoice')
@Controller('staff')
export class StaffPlanRequestsController {
  constructor(
    private readonly requests: PlanRequestsService,
    private readonly settings: PlanSettingsService,
  ) {}

  @Get('plan-requests')
  @ApiOperation({ summary: 'List plan requests of a status, oldest first' })
  @ApiOkResponse({ type: ListOf(PlanRequestView) })
  async queue(
    @Query() q: PlanRequestQueueDto,
  ): Promise<ListResponse<PlanRequestView>> {
    return bounded(await this.requests.queue(q.status), (r) => r);
  }

  @Get('plan-requests/:id')
  @ApiOperation({ summary: 'Get a plan request' })
  @ApiOkResponse({ type: PlanRequestView })
  get(@Param('id', parseId()) id: string): Promise<PlanRequestRead> {
    return this.requests.get(id);
  }

  @Post('plan-requests/:id/accept')
  @ApiOperation({
    summary: 'Accept a plan request with the instalments you set',
    description:
      'The same split as converting the invoice yourself (ADR 0048): the instalments add up to what it owes now.',
  })
  @ApiCreatedResponse({ type: PlanRequestView })
  accept(
    @Param('id', parseId()) id: string,
    @Body() dto: ConvertToInstalmentsDto,
  ): Promise<PlanRequestRead> {
    return this.requests.accept(id, dto);
  }

  @Post('plan-requests/:id/decline')
  @ApiOperation({ summary: 'Decline a plan request with a reason code' })
  @ApiCreatedResponse({ type: PlanRequestView })
  decline(
    @Param('id', parseId()) id: string,
    @Body() dto: DeclinePlanRequestDto,
  ): Promise<PlanRequestRead> {
    return this.requests.decline(id, dto.reasonCode);
  }

  @Get('finance/plan-settings')
  @ApiOperation({ summary: 'The compound’s payment plan terms for residents' })
  @ApiOkResponse({ type: PlanSettingsView })
  getSettings(): Promise<PlanSettings> {
    return this.settings.get();
  }

  @Patch('finance/plan-settings')
  @ApiOperation({ summary: 'Change the payment plan terms for residents' })
  @ApiOkResponse({ type: PlanSettingsView })
  setSettings(@Body() dto: PlanSettingsDto): Promise<PlanSettings> {
    return this.settings.set(dto);
  }
}
