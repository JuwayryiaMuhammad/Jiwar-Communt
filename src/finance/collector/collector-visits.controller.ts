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
import { CollectorSettingsService } from './collector-settings.service';
import {
  CollectorVisitsService,
  type CollectorVisitRead,
} from './collector-visits.service';
import {
  AskCollectorVisitDto,
  AssignCollectorDto,
  CancelCollectorVisitDto,
  CollectedDto,
  CollectorSettingsDto,
  CollectorVisitQueueDto,
  FailedVisitDto,
} from './dto/collector.dto';
import {
  CollectorSettingsView,
  CollectorView,
  CollectorVisitView,
} from './views/collector.views';

/** A collector's visit, asked for by whoever pays the unit's money (ADR 0069). */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller()
export class CollectorVisitsController {
  constructor(private readonly visits: CollectorVisitsService) {}

  @Post('units/:unitId/collector-visits')
  @Idempotent()
  @ApiOperation({ summary: 'Ask for a collector to take cash at my unit' })
  @ApiCreatedResponse({ type: CollectorVisitView })
  ask(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: AskCollectorVisitDto,
  ): Promise<CollectorVisitRead> {
    return this.visits.ask(unitId, dto);
  }

  @Get('units/:unitId/collector-visits')
  @ApiOperation({ summary: 'List my unit’s collector visits, newest first' })
  @ApiOkResponse({ type: ListOf(CollectorVisitView) })
  async forUnit(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<CollectorVisitView>> {
    return bounded(await this.visits.forUnit(unitId), (v) => v);
  }

  @Post('collector-visits/:id/cancel')
  @ApiOperation({ summary: 'Call off a collector visit of my unit' })
  @ApiCreatedResponse({ type: CollectorVisitView })
  cancel(@Param('id', parseId()) id: string): Promise<CollectorVisitRead> {
    return this.visits.cancelByResident(id);
  }

  @Post('collector-visits/:id/accept-offer')
  @ApiOperation({
    summary: 'Take the window a collector offered as a new visit, once',
  })
  @ApiCreatedResponse({ type: CollectorVisitView })
  acceptOffer(@Param('id', parseId()) id: string): Promise<CollectorVisitRead> {
    return this.visits.acceptOffer(id);
  }
}

/** Collector visits for the staff who keep payments (`finance.payments`). */
@ApiArea('finance')
@RequirePermissions('finance.payments')
@Controller('staff')
export class StaffCollectorVisitsController {
  constructor(
    private readonly visits: CollectorVisitsService,
    private readonly settings: CollectorSettingsService,
  ) {}

  @Get('collector-visits')
  @ApiOperation({ summary: 'List collector visits, the soonest window first' })
  @ApiOkResponse({ type: ListOf(CollectorVisitView) })
  async queue(
    @Query() q: CollectorVisitQueueDto,
  ): Promise<ListResponse<CollectorVisitView>> {
    return bounded(await this.visits.queue(q.status), (v) => v);
  }

  @Get('collectors')
  @ApiOperation({ summary: 'List who may be given a collector visit' })
  @ApiOkResponse({ type: ListOf(CollectorView) })
  async collectors(): Promise<ListResponse<CollectorView>> {
    return bounded(await this.visits.collectors(), (c) => c);
  }

  @Get('collector-visits/:id')
  @ApiOperation({ summary: 'Get a collector visit' })
  @ApiOkResponse({ type: CollectorVisitView })
  get(@Param('id', parseId()) id: string): Promise<CollectorVisitRead> {
    return this.visits.get(id);
  }

  @Post('collector-visits/:id/assign')
  @ApiOperation({ summary: 'Give a collector visit to a collector' })
  @ApiCreatedResponse({ type: CollectorVisitView })
  assign(
    @Param('id', parseId()) id: string,
    @Body() dto: AssignCollectorDto,
  ): Promise<CollectorVisitRead> {
    return this.visits.assign(id, dto.collectorId);
  }

  @Post('collector-visits/:id/cancel')
  @ApiOperation({ summary: 'Call off a collector visit, with a reason code' })
  @ApiCreatedResponse({ type: CollectorVisitView })
  cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelCollectorVisitDto,
  ): Promise<CollectorVisitRead> {
    return this.visits.cancelByStaff(id, dto.reasonCode);
  }

  @Get('finance/collector-settings')
  @ApiOperation({ summary: 'What a collector may take above what a unit owes' })
  @ApiOkResponse({ type: CollectorSettingsView })
  getSettings(): Promise<{ collectorMargin: string }> {
    return this.settings.get();
  }

  @Patch('finance/collector-settings')
  @ApiOperation({ summary: 'Change the collector’s margin' })
  @ApiOkResponse({ type: CollectorSettingsView })
  setSettings(
    @Body() dto: CollectorSettingsDto,
  ): Promise<{ collectorMargin: string }> {
    return this.settings.set(dto.collectorMargin);
  }
}

/** The collector's own visits (`finance.collect`). */
@ApiArea('finance')
@RequirePermissions('finance.collect')
@Controller('collector/visits')
export class CollectorController {
  constructor(private readonly visits: CollectorVisitsService) {}

  @Get()
  @ApiOperation({
    summary: 'My visits: the open ones, and those closed in the last day',
  })
  @ApiOkResponse({ type: ListOf(CollectorVisitView) })
  async mine(): Promise<ListResponse<CollectorVisitView>> {
    return bounded(await this.visits.mine(), (v) => v);
  }

  @Post(':id/collected')
  @Idempotent()
  @ApiOperation({
    summary:
      'Record the cash taken on my visit: an office payment and its receipt',
  })
  @ApiCreatedResponse({ type: CollectorVisitView })
  collected(
    @Param('id', parseId()) id: string,
    @Body() dto: CollectedDto,
  ): Promise<CollectorVisitRead> {
    return this.visits.collected(id, dto.amount);
  }

  @Post(':id/failed')
  @ApiOperation({ summary: 'Record why my visit failed; offer another window' })
  @ApiCreatedResponse({ type: CollectorVisitView })
  failed(
    @Param('id', parseId()) id: string,
    @Body() dto: FailedVisitDto,
  ): Promise<CollectorVisitRead> {
    return this.visits.failed(id, dto);
  }
}
