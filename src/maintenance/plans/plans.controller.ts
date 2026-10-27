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
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreatePlanDto,
  DeferPlanDto,
  PlansQueryDto,
  UpdatePlanDto,
} from './dto/plans.dto';
import { PlansService } from './plans.service';
import {
  MaintenancePlanSummaryView,
  MaintenancePlanView,
  PlanEventView,
  PlanOccurrenceView,
} from './views/plan.views';

/** Assets' maintenance plans (ADR 0064). */
@ApiArea('maintenance')
@Controller('maintenance/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'List plans, newest first' })
  @ApiOkResponse({ type: ListOf(MaintenancePlanSummaryView) })
  async list(
    @Query() q: PlansQueryDto,
  ): Promise<ListResponse<MaintenancePlanSummaryView>> {
    return toList(await this.plans.list(q), (p) =>
      MaintenancePlanSummaryView.from(p),
    );
  }

  @Post()
  @RequirePermissions('assets.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Plan an asset’s work' })
  @ApiCreatedResponse({ type: MaintenancePlanView })
  async create(@Body() dto: CreatePlanDto): Promise<MaintenancePlanView> {
    return MaintenancePlanView.fromRead(await this.plans.create(dto));
  }

  @Get(':id')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'Get a plan and its record' })
  @ApiOkResponse({ type: MaintenancePlanView })
  async get(@Param('id', parseId()) id: string): Promise<MaintenancePlanView> {
    return MaintenancePlanView.fromRead(await this.plans.get(id));
  }

  @Patch(':id')
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Change a plan: a new series re-times its next due date',
  })
  @ApiOkResponse({ type: MaintenancePlanView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdatePlanDto,
  ): Promise<MaintenancePlanView> {
    return MaintenancePlanView.fromRead(await this.plans.update(id, dto));
  }

  @Post(':id/deactivate')
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Turn a plan off; `reasonCode` from `planDeactivate`',
  })
  @ApiCreatedResponse({ type: MaintenancePlanView })
  async deactivate(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MaintenancePlanView> {
    return MaintenancePlanView.fromRead(
      await this.plans.deactivate(id, dto.reasonCode),
    );
  }

  @Post(':id/reactivate')
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Turn a plan on again, re-timed from today' })
  @ApiCreatedResponse({ type: MaintenancePlanView })
  async reactivate(
    @Param('id', parseId()) id: string,
  ): Promise<MaintenancePlanView> {
    return MaintenancePlanView.fromRead(await this.plans.reactivate(id));
  }

  @Post(':id/defer')
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Move the next due date; `reasonCode` from `planDefer`',
  })
  @ApiCreatedResponse({ type: MaintenancePlanView })
  async defer(
    @Param('id', parseId()) id: string,
    @Body() dto: DeferPlanDto,
  ): Promise<MaintenancePlanView> {
    return MaintenancePlanView.fromRead(await this.plans.defer(id, dto));
  }

  @Post(':id/skip')
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Skip the next due date; `reasonCode` from `planSkip`',
  })
  @ApiCreatedResponse({ type: MaintenancePlanView })
  async skip(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MaintenancePlanView> {
    return MaintenancePlanView.fromRead(
      await this.plans.skip(id, dto.reasonCode),
    );
  }

  @Get(':id/occurrences')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'A plan’s due dates, newest first' })
  @ApiOkResponse({ type: ListOf(PlanOccurrenceView) })
  async occurrences(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PlanOccurrenceView>> {
    return toList(await this.plans.occurrences(id, q), (o) =>
      PlanOccurrenceView.from(o),
    );
  }

  @Get(':id/events')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'What happened to a plan, newest first' })
  @ApiOkResponse({ type: ListOf(PlanEventView) })
  async events(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PlanEventView>> {
    return toList(await this.plans.events(id, q), (e) => PlanEventView.from(e));
  }
}

/** An open occurrence of a plan (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/plan-occurrences')
export class PlanOccurrencesController {
  constructor(private readonly plans: PlansService) {}

  @Post(':id/defer')
  @ApiOperation({
    summary:
      'Move an open occurrence’s due date; `reasonCode` from `planDefer`',
  })
  @ApiCreatedResponse({ type: PlanOccurrenceView })
  async defer(
    @Param('id', parseId()) id: string,
    @Body() dto: DeferPlanDto,
  ): Promise<PlanOccurrenceView> {
    return PlanOccurrenceView.from(await this.plans.deferOccurrence(id, dto));
  }
}
