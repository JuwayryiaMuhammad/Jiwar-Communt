import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ChecklistAnswerDto } from '../checklists/dto/checklists.dto';
import {
  CreateInspectionDto,
  CreateRoundDto,
  InspectionReportQueryDto,
  InspectionsQueryDto,
  MyInspectionsQueryDto,
  RoundsQueryDto,
  StartInspectionDto,
  UpdateRoundDto,
} from './dto/inspections.dto';
import { InspectionReports } from './inspection-reports';
import { InspectionsService } from './inspections.service';
import {
  InspectionReportView,
  InspectionRoundView,
  InspectionSummaryView,
  InspectionView,
} from './views/inspection.views';

/** Recurring inspections (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('inspections.manage')
@Controller('maintenance/inspection-rounds')
export class InspectionRoundsController {
  constructor(private readonly inspections: InspectionsService) {}

  @Get()
  @ApiOperation({ summary: 'List inspection rounds by next due date' })
  @ApiOkResponse({ type: ListOf(InspectionRoundView) })
  async list(
    @Query() q: RoundsQueryDto,
  ): Promise<ListResponse<InspectionRoundView>> {
    return bounded(await this.inspections.rounds(q), (r) =>
      InspectionRoundView.from(r),
    );
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Add an inspection round' })
  @ApiCreatedResponse({ type: InspectionRoundView })
  async create(@Body() dto: CreateRoundDto): Promise<InspectionRoundView> {
    return InspectionRoundView.from(await this.inspections.createRound(dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an inspection round' })
  @ApiOkResponse({ type: InspectionRoundView })
  async get(@Param('id', parseId()) id: string): Promise<InspectionRoundView> {
    return InspectionRoundView.from(await this.inspections.round(id));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a round: a new series re-times its next date',
  })
  @ApiOkResponse({ type: InspectionRoundView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateRoundDto,
  ): Promise<InspectionRoundView> {
    return InspectionRoundView.from(
      await this.inspections.updateRound(id, dto),
    );
  }

  @Post(':id/deactivate')
  @ApiOperation({ summary: 'Turn a round off' })
  @ApiCreatedResponse({ type: InspectionRoundView })
  async deactivate(
    @Param('id', parseId()) id: string,
  ): Promise<InspectionRoundView> {
    return InspectionRoundView.from(
      await this.inspections.setRoundActive(id, false),
    );
  }

  @Post(':id/reactivate')
  @ApiOperation({ summary: 'Turn a round on again, re-timed from today' })
  @ApiCreatedResponse({ type: InspectionRoundView })
  async reactivate(
    @Param('id', parseId()) id: string,
  ): Promise<InspectionRoundView> {
    return InspectionRoundView.from(
      await this.inspections.setRoundActive(id, true),
    );
  }
}

/** Inspections, for who manages them (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('inspections.manage')
@Controller('maintenance/inspections')
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  @Get()
  @ApiOperation({ summary: 'List inspections, latest due first' })
  @ApiOkResponse({ type: ListOf(InspectionSummaryView) })
  async list(
    @Query() q: InspectionsQueryDto,
  ): Promise<ListResponse<InspectionSummaryView>> {
    return toList(await this.inspections.list(q), (i) =>
      InspectionSummaryView.from(i),
    );
  }

  /** No-store: the checklist's photos are presigned URLs. */
  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({ summary: 'Schedule an inspection on its own' })
  @ApiCreatedResponse({ type: InspectionView })
  async create(@Body() dto: CreateInspectionDto): Promise<InspectionView> {
    return InspectionView.fromRead(await this.inspections.create(dto));
  }

  /** No-store: the checklist's photos are presigned URLs. */
  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get an inspection with its checklist and findings',
  })
  @ApiOkResponse({ type: InspectionView })
  async get(@Param('id', parseId()) id: string): Promise<InspectionView> {
    return InspectionView.fromRead(await this.inspections.get(id, 'manage'));
  }

  /** No-store: the checklist's photos are presigned URLs. */
  @Post(':id/cancel')
  @NoStore()
  @ApiOperation({
    summary: 'Call an inspection off; `reasonCode` from `inspectionCancel`',
  })
  @ApiCreatedResponse({ type: InspectionView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<InspectionView> {
    return InspectionView.fromRead(
      await this.inspections.cancel(id, dto.reasonCode),
    );
  }
}

const CSV =
  'One row per inspection due in the period: due_on, status, target_kind, target_code, checklist_key, inspector_id, submitted_on, on_time, failed_items, findings, findings_closed.';

/** The inspections of a period (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('inspections.manage')
@Controller('maintenance/inspection-report')
export class InspectionReportController {
  constructor(private readonly reports: InspectionReports) {}

  @Get()
  @ApiOperation({
    summary: 'The inspections of a period: done, on time, failed, followed up',
  })
  @ApiOkResponse({ type: InspectionReportView })
  async report(
    @Query() q: InspectionReportQueryDto,
  ): Promise<InspectionReportView> {
    return InspectionReportView.from(await this.reports.report(q.from, q.to));
  }

  @Get('export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export the inspections of a period as CSV',
    description: CSV,
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: InspectionReportQueryDto): Promise<StreamableFile> {
    return csvFile(
      `inspections-${q.from}-${q.to}.csv`,
      await this.reports.csv(q.from, q.to),
    );
  }
}

/** My inspections, as the inspector performs them (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('inspections.perform')
@Controller('technician/inspections')
export class MyInspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  @Get()
  @ApiOperation({ summary: 'List my inspections, latest due first' })
  @ApiOkResponse({ type: ListOf(InspectionSummaryView) })
  async list(
    @Query() q: MyInspectionsQueryDto,
  ): Promise<ListResponse<InspectionSummaryView>> {
    return toList(await this.inspections.list(q, true), (i) =>
      InspectionSummaryView.from(i),
    );
  }

  /** No-store: the checklist's photos are presigned URLs. */
  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get my inspection with its checklist' })
  @ApiOkResponse({ type: InspectionView })
  async get(@Param('id', parseId()) id: string): Promise<InspectionView> {
    return InspectionView.fromRead(await this.inspections.get(id, 'perform'));
  }

  @Post(':id/start')
  @NoStore()
  @ApiOperation({ summary: 'Start (or scan the tag of) my inspection' })
  @ApiCreatedResponse({ type: InspectionView })
  async start(
    @Param('id', parseId()) id: string,
    @Body() dto: StartInspectionDto,
  ): Promise<InspectionView> {
    return InspectionView.fromRead(await this.inspections.start(id, dto.code));
  }

  @Put(':id/items/:itemId')
  @NoStore()
  @ApiOperation({
    summary: 'Answer an item of my inspection (again, until submitted)',
  })
  @ApiOkResponse({ type: InspectionView })
  async answer(
    @Param('id', parseId()) id: string,
    @Param('itemId', parseId('itemId')) itemId: string,
    @Body() dto: ChecklistAnswerDto,
  ): Promise<InspectionView> {
    return InspectionView.fromRead(
      await this.inspections.answer(id, itemId, dto),
    );
  }

  @Post(':id/submit')
  @NoStore()
  @ApiOperation({
    summary: 'Submit my inspection: its findings open follow-up work orders',
  })
  @ApiCreatedResponse({ type: InspectionView })
  async submit(@Param('id', parseId()) id: string): Promise<InspectionView> {
    return InspectionView.fromRead(await this.inspections.submit(id));
  }
}
