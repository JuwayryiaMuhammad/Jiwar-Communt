import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { FieldErrorCode } from '../common/errors';
import { ApiArea } from '../common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../common/http/list';
import { invalid } from '../common/localized';
import { parseId } from '../common/validation/parse-id.pipe';
import { CompensationsService } from './compensations.service';
import {
  AssignCaseDto,
  ExperienceCasesQueryDto,
  CloseCaseDto,
  CompensationsQueryDto,
  CreatePromiseDto,
  DecideCompensationDto,
  ExperiencePeriodQueryDto,
  OpenCaseDto,
  PromisesQueryDto,
  ProposeCompensationDto,
  SignalsQueryDto,
  UpdateCompensationRulesDto,
  UpdateExperienceSettingsDto,
  UpdatePromiseDto,
} from './dto/experience.dto';
import { ExperienceCasesService } from './experience-cases.service';
import { ExperienceReportsService } from './experience-reports.service';
import { ExperienceSettingsService } from './experience-settings.service';
import { ExperienceSignalsService } from './experience-signals.service';
import {
  ExperienceCaseView,
  CompensationRuleView,
  CompensationView,
  ExperienceSettingsView,
  PromisesReportView,
  RatingsReportView,
  ServicePromiseView,
  ExperienceSignalView,
} from './experience.views';
import { ServicePromisesService } from './service-promises.service';

/**
 * Experience and recovery (ADR 0082), the staff's with `experience.manage`:
 * the signal thresholds, the signals, the follow-up and recovery cases, the
 * compensations proposed on them and the rules that recommend one, the
 * service promises register and the ratings report.
 */
@ApiArea('staff')
@RequirePermissions('experience.manage')
@Controller('staff/experience')
export class ExperienceController {
  constructor(
    private readonly settings: ExperienceSettingsService,
    private readonly signals: ExperienceSignalsService,
    private readonly cases: ExperienceCasesService,
    private readonly compensations: CompensationsService,
    private readonly promises: ServicePromisesService,
    private readonly reports: ExperienceReportsService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'The dissatisfaction rules’ thresholds' })
  @ApiOkResponse({ type: ExperienceSettingsView })
  async getSettings(): Promise<ExperienceSettingsView> {
    return ExperienceSettingsView.from(await this.settings.get());
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Change some rules’ thresholds; `count: null` turns one off',
  })
  @ApiOkResponse({ type: ExperienceSettingsView })
  async updateSettings(
    @Body() dto: UpdateExperienceSettingsDto,
  ): Promise<ExperienceSettingsView> {
    const seen = new Set<string>();
    dto.items.forEach((item, i) => {
      if (seen.has(item.code))
        throw invalid([
          { field: `items[${i}].code`, code: FieldErrorCode.DUPLICATE_VALUE },
        ]);
      seen.add(item.code);
    });
    return ExperienceSettingsView.from(await this.settings.update(dto.items));
  }

  @Get('signals')
  @ApiOperation({ summary: 'List the signals raised, the newest first' })
  @ApiOkResponse({ type: ListOf(ExperienceSignalView) })
  async listSignals(
    @Query() q: SignalsQueryDto,
  ): Promise<ListResponse<ExperienceSignalView>> {
    return toList(await this.signals.list(q), (s) =>
      ExperienceSignalView.from(s),
    );
  }

  @Get('cases')
  @ApiOperation({ summary: 'List the cases, the newest first' })
  @ApiOkResponse({ type: ListOf(ExperienceCaseView) })
  async listCases(
    @Query() q: ExperienceCasesQueryDto,
  ): Promise<ListResponse<ExperienceCaseView>> {
    return toList(await this.cases.list(q), (c) => ExperienceCaseView.from(c));
  }

  /** One open case per unit: EXPERIENCE_CASE_OPEN (params.caseId) otherwise. */
  @Post('cases')
  @ApiOperation({ summary: 'Open a follow-up or recovery case for a unit' })
  @ApiCreatedResponse({ type: ExperienceCaseView })
  async openCase(@Body() dto: OpenCaseDto): Promise<ExperienceCaseView> {
    if (!dto.sourceType !== !dto.sourceId)
      throw invalid([
        {
          field: dto.sourceType ? 'sourceId' : 'sourceType',
          code: FieldErrorCode.FIELD_REQUIRED,
        },
      ]);
    return this.caseView(
      await this.cases.open({
        unitId: dto.unitId,
        kind: dto.kind,
        source:
          dto.sourceType && dto.sourceId
            ? { type: dto.sourceType, id: dto.sourceId }
            : null,
        failureCode: dto.failureCode ?? null,
        note: dto.note ?? null,
        ownerId: dto.ownerId ?? null,
      }),
    );
  }

  @Get('cases/:id')
  @ApiOperation({
    summary: 'Get one case, with its signals and compensations',
  })
  @ApiOkResponse({ type: ExperienceCaseView })
  async getCase(
    @Param('id', parseId()) id: string,
  ): Promise<ExperienceCaseView> {
    return this.caseView(await this.cases.get(id));
  }

  @Post('cases/:id/assign')
  @ApiOperation({ summary: 'Name an open case’s owner, who is told' })
  @ApiCreatedResponse({ type: ExperienceCaseView })
  async assign(
    @Param('id', parseId()) id: string,
    @Body() dto: AssignCaseDto,
  ): Promise<ExperienceCaseView> {
    return this.caseView(await this.cases.assign(id, dto.ownerId));
  }

  @Post('cases/:id/close')
  @ApiOperation({
    summary:
      'Close a case once with an outcome; never while a compensation waits',
  })
  @ApiCreatedResponse({ type: ExperienceCaseView })
  async close(
    @Param('id', parseId()) id: string,
    @Body() dto: CloseCaseDto,
  ): Promise<ExperienceCaseView> {
    return this.caseView(
      await this.cases.close(id, { outcome: dto.outcome, note: dto.note }),
    );
  }

  @Post('cases/:id/compensations')
  @ApiOperation({
    summary: 'Propose a compensation on an open case, for the manager',
  })
  @ApiCreatedResponse({ type: CompensationView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: ProposeCompensationDto,
  ): Promise<CompensationView> {
    const row = await this.compensations.propose(id, dto);
    return CompensationView.from(row, await this.compensations.authority(null));
  }

  @Get('compensations')
  @ApiOperation({
    summary: 'List the compensations, the oldest first',
    description:
      'A proposed one says who decides it now: `board` above a binding compensation_above_limit threshold.',
  })
  @ApiOkResponse({ type: ListOf(CompensationView) })
  async listCompensations(
    @Query() q: CompensationsQueryDto,
  ): Promise<ListResponse<CompensationView>> {
    const limit = await this.compensations.authority(null);
    return toList(await this.compensations.list(q), (c) =>
      CompensationView.from(c, limit),
    );
  }

  @Get('compensations/:id')
  @ApiOperation({ summary: 'Get one compensation' })
  @ApiOkResponse({ type: CompensationView })
  async getCompensation(
    @Param('id', parseId()) id: string,
  ): Promise<CompensationView> {
    return CompensationView.from(
      await this.compensations.get(id),
      await this.compensations.authority(null),
    );
  }

  @Get('compensation-rules')
  @ApiOperation({ summary: 'What the compound recommends for each failure' })
  @ApiOkResponse({ type: ListOf(CompensationRuleView) })
  async rules(): Promise<ListResponse<CompensationRuleView>> {
    return bounded(await this.compensations.rules(), (r) =>
      CompensationRuleView.from(r),
    );
  }

  @Put('compensation-rules')
  @ApiOperation({
    summary: 'Set some failures’ recommendations; `kind: null` removes one',
  })
  @ApiOkResponse({ type: ListOf(CompensationRuleView) })
  async setRules(
    @Body() dto: UpdateCompensationRulesDto,
  ): Promise<ListResponse<CompensationRuleView>> {
    return bounded(await this.compensations.setRules(dto.items), (r) =>
      CompensationRuleView.from(r),
    );
  }

  @Get('promises')
  @ApiOperation({ summary: 'The service promises register' })
  @ApiOkResponse({ type: ListOf(ServicePromiseView) })
  async listPromises(
    @Query() q: PromisesQueryDto,
  ): Promise<ListResponse<ServicePromiseView>> {
    return bounded(
      await this.promises.list({
        active: q.active === undefined ? undefined : q.active === 'true',
      }),
      (p) => ServicePromiseView.from(p),
    );
  }

  @Post('promises')
  @ApiOperation({ summary: 'Add a service promise, measured or not' })
  @ApiCreatedResponse({ type: ServicePromiseView })
  async createPromise(
    @Body() dto: CreatePromiseDto,
  ): Promise<ServicePromiseView> {
    return ServicePromiseView.from(
      await this.promises.create({
        titleEn: dto.titleEn,
        titleAr: dto.titleAr,
        metric: dto.metric ?? null,
        target: dto.target ?? null,
        targetShare: dto.targetShare ?? null,
      }),
    );
  }

  @Patch('promises/:id')
  @ApiOperation({ summary: 'Change or retire a service promise' })
  @ApiOkResponse({ type: ServicePromiseView })
  async updatePromise(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdatePromiseDto,
  ): Promise<ServicePromiseView> {
    return ServicePromiseView.from(await this.promises.update(id, dto));
  }

  @Get('promises/report')
  @ApiOperation({
    summary: 'The active promises against their targets over a period',
  })
  @ApiOkResponse({ type: PromisesReportView })
  async promisesReport(
    @Query() q: ExperiencePeriodQueryDto,
  ): Promise<PromisesReportView> {
    return PromisesReportView.from(await this.promises.report(q));
  }

  @Get('ratings-report')
  @ApiOperation({
    summary:
      'The ratings over a period: by source and building, the low ratings’ reasons, the units with repeated low ratings',
  })
  @ApiOkResponse({ type: RatingsReportView })
  async ratingsReport(
    @Query() q: ExperiencePeriodQueryDto,
  ): Promise<RatingsReportView> {
    return RatingsReportView.from(await this.reports.ratings(q));
  }

  private async caseView(c: Parameters<typeof ExperienceCaseView.from>[0]) {
    return ExperienceCaseView.from(c, await this.compensations.authority(null));
  }
}

/** The manager's decision on a compensation (ADR 0082): never a deputy's. */
@ApiArea('staff')
@RequirePermissions('experience.compensate')
@Controller('staff/experience/compensations')
export class CompensationDecisionsController {
  constructor(private readonly compensations: CompensationsService) {}

  @Post(':id/decide')
  @ApiOperation({
    summary: 'Approve or reject a compensation, once',
    description:
      'Approving a credit issues a credit note on `invoiceId` through finance (ADR 0058’s compensation); above the binding compensation_above_limit threshold it names `authorizationId`, what the board approved (ADR 0073). Two decisions at once: one wins, the other is COMPENSATION_DECIDED.',
  })
  @ApiCreatedResponse({ type: CompensationView })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideCompensationDto,
  ): Promise<CompensationView> {
    return CompensationView.from(await this.compensations.decide(id, dto));
  }
}
