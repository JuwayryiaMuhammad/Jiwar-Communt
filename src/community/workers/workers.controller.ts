import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
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
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  BirthDateDto,
  CardIncidentDto,
  EngagementsQueryDto,
  NewWorkerDto,
  OpenClosedQueryDto,
  ReissueCodeDto,
  ReviewDto,
  WorkerPhotoDto,
} from './dto/workers.dto';
import {
  PayWageDto,
  SetWageDto,
  SettleWageObligationDto,
} from './dto/wages.dto';
import { WagePaymentView, WageView } from './views/wage.views';
import { WorkerWagesService } from './worker-wages.service';
import {
  AccessCodeView,
  CardIncidentCreatedView,
  WorkerCardView,
  CardIncidentResponse,
  CaseCreatedView,
  ComplianceCaseResponse,
  EngagementDetailView,
  EngagementResponse,
  RegisteredView,
  ReviewEngagementView,
  UnitEngagementView,
} from './views/workers.views';
import { WorkersService } from './workers.service';

/** Domestic workers (ADR 0017, 0022): engagements, codes, review, compliance, incidents. */
@ApiArea('workers')
@Controller()
export class WorkersController {
  constructor(
    private readonly workers: WorkersService,
    private readonly wages: WorkerWagesService,
  ) {}

  // Residents and delegates ----------------------------------------------

  /** A landlord sees the unit, never who works in it. */
  @RequirePermissions('workers.manage')
  @Get('units/:unitId/workers')
  @ApiOperation({ summary: "List the unit's workers" })
  @ApiOkResponse({ type: ListOf(EngagementResponse) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<EngagementResponse>> {
    return toList(await this.workers.listForUnit(unitId, q), (e) =>
      EngagementResponse.from(e),
    );
  }

  /**
   * One of the unit's workers (ADR 0037): the list item and the last month
   * paid. Another unit's engagement is ENGAGEMENT_NOT_FOUND; the manager's
   * `GET /worker-engagements/:id` is a different view.
   */
  @RequirePermissions('workers.manage')
  @Get('units/:unitId/workers/:id')
  @ApiOperation({ summary: "Get one of the unit's workers" })
  @ApiOkResponse({ type: UnitEngagementView })
  async one(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<UnitEngagementView> {
    return UnitEngagementView.fromDetail(
      await this.workers.engagementForUnit(unitId, id),
    );
  }

  /** Pending review; a schedule clash elsewhere only warns. */
  @RequirePermissions('workers.manage')
  @Post('units/:unitId/workers')
  @ApiOperation({ summary: 'Register a worker for the unit' })
  @ApiCreatedResponse({ type: RegisteredView })
  async register(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewWorkerDto,
  ): Promise<RegisteredView> {
    return RegisteredView.from(await this.workers.register(unitId, dto));
  }

  /** The code is kept but stops working; the worker gets a notice. */
  @RequireAnyPermission('workers.manage', 'workers.review')
  @Post('worker-engagements/:id/suspend')
  @ApiOperation({ summary: "Suspend a worker's engagement" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async suspend(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.workers.suspend(id, reasonOf(dto));
  }

  /** The same code works again; a new one only when none is left. */
  @RequireAnyPermission('workers.manage', 'workers.review')
  @Post('worker-engagements/:id/resume')
  @ApiOperation({ summary: "Resume a worker's engagement" })
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: AccessCodeView })
  async resume(@Param('id', parseId()) id: string): Promise<AccessCodeView> {
    return AccessCodeView.from(id, await this.workers.resume(id));
  }

  @RequireAnyPermission('workers.manage', 'workers.review')
  @Post('worker-engagements/:id/end')
  @ApiOperation({ summary: "End a worker's engagement" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async end(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.workers.end(id, reasonOf(dto));
  }

  // Wages (ADR 0037): recorded, never processed --------------------------

  /** While the engagement is open; null clears it. */
  @RequirePermissions('workers.manage')
  @Put('worker-engagements/:id/wage')
  @ApiOperation({ summary: "Set or clear a worker's monthly wage" })
  @ApiOkResponse({ type: WageView })
  async setWage(
    @Param('id', parseId()) id: string,
    @Body() dto: SetWageDto,
  ): Promise<WageView> {
    return { monthlyWage: await this.wages.setWage(id, dto.monthlyWage) };
  }

  /**
   * One month, once: the worker gets a notice, the payer and the unit's
   * primary a receipt by email. It settles no wage obligation (ADR 0037):
   * a manager does.
   */
  @RequirePermissions('workers.manage')
  @Post('worker-engagements/:id/wage-payments')
  @ApiOperation({ summary: "Record a month's wage payment" })
  @ApiCreatedResponse({ type: WagePaymentView })
  async pay(
    @Param('id', parseId()) id: string,
    @Body() dto: PayWageDto,
  ): Promise<WagePaymentView> {
    return WagePaymentView.from(await this.wages.pay(id, dto));
  }

  /** The household's payments; managers read them for payroll. */
  @RequireAnyPermission('workers.manage', 'workers.review')
  @Get('worker-engagements/:id/wage-payments')
  @ApiOperation({ summary: "List a worker's wage payments" })
  @ApiOkResponse({ type: ListOf(WagePaymentView) })
  async payments(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<WagePaymentView>> {
    return toList(await this.wages.payments(id, q), (p) =>
      WagePaymentView.from(p),
    );
  }

  /**
   * A manager closes one of the engagement's open wage obligations (ADR
   * 0022, 0037), named by kind, with a reason code: a recorded payment
   * never does.
   */
  @RequirePermissions('workers.review')
  @Post('worker-engagements/:id/wage-obligation/settle')
  @ApiOperation({ summary: "Settle an engagement's open wage obligation" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async settleWageObligation(
    @Param('id', parseId()) id: string,
    @Body() dto: SettleWageObligationDto,
  ): Promise<void> {
    await this.wages.settleObligation(id, dto.reasonCode, dto.kind);
  }

  /** The old code is dead at once. */
  @RequireAnyPermission('workers.manage', 'workers.review')
  @Post('worker-engagements/:id/reissue-code')
  @ApiOperation({ summary: "Reissue a worker's access code" })
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: AccessCodeView })
  async reissue(
    @Param('id', parseId()) id: string,
    @Body() dto: ReissueCodeDto,
  ): Promise<AccessCodeView> {
    return AccessCodeView.from(
      id,
      await this.workers.reissueCode(id, dto.reasonCode ?? ''),
    );
  }

  /**
   * Management files a lost or confiscated card (ADR 0022); a new code is
   * issued at once. Residents never file one: they use reissue-code.
   */
  @RequirePermissions('workers.incidents')
  @Post('worker-engagements/:id/card-incident')
  @ApiOperation({ summary: 'File a lost or confiscated worker card' })
  @NoStore()
  @ApiCreatedResponse({ type: CardIncidentCreatedView })
  async cardIncident(
    @Param('id', parseId()) id: string,
    @Body() dto: CardIncidentDto,
  ): Promise<CardIncidentCreatedView> {
    const issued = await this.workers.reportCardIncident(
      id,
      dto.type,
      dto.note,
    );
    return {
      incidentId: issued.incidentId,
      engagementId: issued.engagementId,
      accessCode: issued.accessCode,
      card: WorkerCardView.from(issued.card),
    };
  }

  // Management review ------------------------------------------------------

  @RequirePermissions('workers.review')
  @Get('worker-engagements')
  @ApiOperation({ summary: 'List worker engagements for review' })
  @ApiOkResponse({ type: ListOf(ReviewEngagementView) })
  async forReview(
    @Query() q: EngagementsQueryDto,
  ): Promise<ListResponse<ReviewEngagementView>> {
    return toList(await this.workers.engagementsForReview(q), (e) =>
      ReviewEngagementView.from(e),
    );
  }

  /** The worker with the birth date to attest; the document masked; the photo's URL. */
  @RequirePermissions('workers.review')
  @Get('worker-engagements/:id')
  @ApiOperation({ summary: 'Get a worker engagement for review' })
  @NoStore()
  @ApiOkResponse({ type: EngagementDetailView })
  async detail(
    @Param('id', parseId()) id: string,
  ): Promise<EngagementDetailView> {
    return EngagementDetailView.from(await this.workers.engagementDetail(id));
  }

  /** Approval issues the code, shown once; a rejection needs a reason. */
  @RequirePermissions('workers.review')
  @Post('worker-engagements/:id/review')
  @ApiOperation({ summary: 'Approve or reject a worker engagement' })
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: AccessCodeView })
  async review(
    @Param('id', parseId()) id: string,
    @Body() dto: ReviewDto,
  ): Promise<AccessCodeView> {
    const reason =
      dto.reasonCode !== undefined || dto.reason !== undefined
        ? reasonOf(dto)
        : undefined;
    return AccessCodeView.from(
      id,
      await this.workers.review(id, dto.decision, {
        reason,
        birthDateConfirmed: dto.birthDateConfirmed,
        birthDate: dto.birthDate,
      }),
    );
  }

  /** Clears a passport worker's attestation; under 18 opens a compliance case. */
  @RequirePermissions('workers.review')
  @Post('workers/:id/birth-date')
  @ApiOperation({ summary: "Attest a worker's birth date" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async birthDate(
    @Param('id', parseId()) id: string,
    @Body() dto: BirthDateDto,
  ): Promise<void> {
    await this.workers.correctBirthDate(id, dto.birthDate);
  }

  /** Sets or replaces the photo; the file moves to the worker (ADR 0029). */
  @RequirePermissions('workers.review')
  @Put('workers/:id/photo')
  @ApiOperation({ summary: "Set or replace a worker's photo" })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async photo(
    @Param('id', parseId()) id: string,
    @Body() dto: WorkerPhotoDto,
  ): Promise<void> {
    await this.workers.setPhoto(id, dto.fileId);
  }

  @RequirePermissions('workers.ban')
  @Post('workers/:id/ban')
  @ApiOperation({ summary: 'Ban a worker from the compound' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async ban(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.workers.ban(id, reasonOf(dto));
  }

  @RequirePermissions('workers.ban')
  @Post('workers/:id/unban')
  @ApiOperation({ summary: 'Lift a worker ban' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async unban(@Param('id', parseId()) id: string): Promise<void> {
    await this.workers.unban(id);
  }

  // Compliance (the compliance officer) -------------------------------------

  @RequirePermissions('workers.compliance')
  @Post('workers/:id/report-underage')
  @ApiOperation({ summary: 'Report an underage worker' })
  @ApiCreatedResponse({ type: CaseCreatedView })
  async reportUnderage(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<CaseCreatedView> {
    return { caseId: await this.workers.reportUnderage(id, reasonOf(dto)) };
  }

  @RequirePermissions('workers.compliance')
  @Get('compliance-cases')
  @ApiOperation({ summary: 'List compliance cases' })
  @ApiOkResponse({ type: ListOf(ComplianceCaseResponse) })
  async cases(
    @Query() q: OpenClosedQueryDto,
  ): Promise<ListResponse<ComplianceCaseResponse>> {
    return toList(await this.workers.complianceCases(q), (c) =>
      ComplianceCaseResponse.from(c),
    );
  }

  @RequirePermissions('workers.compliance')
  @Post('compliance-cases/:id/close')
  @ApiOperation({ summary: 'Close a compliance case' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async closeCase(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.workers.closeComplianceCase(id, reasonOf(dto));
  }

  // Card incidents -----------------------------------------------------------

  /** Never the note. */
  @RequirePermissions('workers.incidents')
  @Get('card-incidents')
  @ApiOperation({ summary: 'List card incidents' })
  @ApiOkResponse({ type: ListOf(CardIncidentResponse) })
  async incidents(
    @Query() q: OpenClosedQueryDto,
  ): Promise<ListResponse<CardIncidentResponse>> {
    return toList(await this.workers.cardIncidents(q), (i) =>
      CardIncidentResponse.from(i),
    );
  }

  @RequirePermissions('workers.incidents')
  @Post('card-incidents/:id/close')
  @ApiOperation({ summary: 'Close a card incident' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async closeIncident(@Param('id', parseId()) id: string): Promise<void> {
    await this.workers.closeCardIncident(id);
  }
}
