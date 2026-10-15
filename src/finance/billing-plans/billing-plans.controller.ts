import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BillingPlansService } from './billing-plans.service';
import {
  CreateBillingPlanDto,
  SetBillingOverrideDto,
  UpdateBillingPlanDto,
} from './dto/billing-plans.dto';
import {
  BillingOverrideView,
  BillingPlanView,
} from './views/billing-plan.views';

/**
 * Recurring billing plans and their per-unit terms (ADR 0046). Those who
 * issue invoices may read them; keeping them is `finance.billing`.
 */
@ApiArea('finance')
@Controller('staff/billing-plans')
export class BillingPlansController {
  constructor(private readonly plans: BillingPlansService) {}

  @Get()
  @RequireAnyPermission('finance.billing', 'finance.invoice')
  @ApiOperation({ summary: 'List the billing plans, active first' })
  @ApiOkResponse({ type: ListOf(BillingPlanView) })
  async list(): Promise<ListResponse<BillingPlanView>> {
    return bounded(await this.plans.list(), (p) => p);
  }

  @Post()
  @RequirePermissions('finance.billing')
  @ApiOperation({
    summary: 'Create a billing plan: every unit, a fixed amount each period',
  })
  @Idempotent()
  @ApiCreatedResponse({ type: BillingPlanView })
  create(@Body() dto: CreateBillingPlanDto): Promise<BillingPlanView> {
    return this.plans.create(dto);
  }

  @Get(':id')
  @RequireAnyPermission('finance.billing', 'finance.invoice')
  @ApiOperation({ summary: 'Get a billing plan and its next period' })
  @ApiOkResponse({ type: BillingPlanView })
  get(@Param('id', parseId()) id: string): Promise<BillingPlanView> {
    return this.plans.get(id);
  }

  @Patch(':id')
  @RequirePermissions('finance.billing')
  @ApiOperation({
    summary: 'Change a plan’s names, amount, days, or retire it',
    description: 'Applies to periods issued afterwards.',
  })
  @ApiOkResponse({ type: BillingPlanView })
  update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateBillingPlanDto,
  ): Promise<BillingPlanView> {
    return this.plans.update(id, dto);
  }

  @Get(':id/overrides')
  @RequireAnyPermission('finance.billing', 'finance.invoice')
  @ApiOperation({ summary: 'List the units with terms of their own' })
  @ApiOkResponse({ type: ListOf(BillingOverrideView) })
  async overrides(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<BillingOverrideView>> {
    return bounded(await this.plans.overrides(id), (o) => o);
  }

  @Put(':id/overrides/:unitId')
  @RequirePermissions('finance.billing')
  @ApiOperation({
    summary: 'Give a unit another amount in the plan, or exclude it',
  })
  @ApiOkResponse({ type: BillingOverrideView })
  setOverride(
    @Param('id', parseId()) id: string,
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: SetBillingOverrideDto,
  ): Promise<BillingOverrideView> {
    return this.plans.setOverride(id, unitId, dto);
  }

  @Delete(':id/overrides/:unitId')
  @RequirePermissions('finance.billing')
  @HttpCode(204)
  @ApiOperation({ summary: 'Put a unit back on the plan’s own terms' })
  @ApiNoContentResponse()
  async removeOverride(
    @Param('id', parseId()) id: string,
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<void> {
    await this.plans.removeOverride(id, unitId);
  }
}
