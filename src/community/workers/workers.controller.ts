import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
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
} from './dto/workers.dto';
import {
  AccessCodeView,
  CardIncidentCreatedView,
  CardIncidentResponse,
  CaseCreatedView,
  ComplianceCaseResponse,
  EngagementDetailView,
  EngagementResponse,
  RegisteredView,
  ReviewEngagementView,
} from './views/workers.views';
import { WorkersService } from './workers.service';

/** Domestic workers (ADR 0017, 0022): engagements, codes, review, compliance, incidents. */
@ApiArea('workers')
@Controller()
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  // Residents and delegates ----------------------------------------------

  /** A landlord sees the unit, never who works in it. */
  @RequirePermissions('workers.manage')
  @Get('units/:unitId/workers')
  @ApiOkResponse({ type: ListOf(EngagementResponse) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<EngagementResponse>> {
    return toList(await this.workers.listForUnit(unitId, q), (e) =>
      EngagementResponse.from(e),
    );
  }

  /** Pending review; a schedule clash elsewhere only warns. */
  @RequirePermissions('workers.manage')
  @Post('units/:unitId/workers')
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
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOkResponse({ type: AccessCodeView })
  async resume(@Param('id', parseId()) id: string): Promise<AccessCodeView> {
    return AccessCodeView.from(id, await this.workers.resume(id));
  }

  @RequireAnyPermission('workers.manage', 'workers.review')
  @Post('worker-engagements/:id/end')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async end(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.workers.end(id, reasonOf(dto));
  }

  /** The old code is dead at once. */
  @RequireAnyPermission('workers.manage', 'workers.review')
  @Post('worker-engagements/:id/reissue-code')
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

  /** A lost or confiscated card: recorded, and a new code issued at once. */
  @RequireAnyPermission('workers.incidents', 'workers.manage')
  @Post('worker-engagements/:id/card-incident')
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
    };
  }

  // Management review ------------------------------------------------------

  @RequirePermissions('workers.review')
  @Get('worker-engagements')
  @ApiOkResponse({ type: ListOf(ReviewEngagementView) })
  async forReview(
    @Query() q: EngagementsQueryDto,
  ): Promise<ListResponse<ReviewEngagementView>> {
    return toList(await this.workers.engagementsForReview(q), (e) =>
      ReviewEngagementView.from(e),
    );
  }

  /** The worker with the birth date to attest; the document masked. */
  @RequirePermissions('workers.review')
  @Get('worker-engagements/:id')
  @ApiOkResponse({ type: EngagementDetailView })
  async detail(
    @Param('id', parseId()) id: string,
  ): Promise<EngagementDetailView> {
    return EngagementDetailView.from(await this.workers.engagementDetail(id));
  }

  /** Approval issues the code, shown once; a rejection needs a reason. */
  @RequirePermissions('workers.review')
  @Post('worker-engagements/:id/review')
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async birthDate(
    @Param('id', parseId()) id: string,
    @Body() dto: BirthDateDto,
  ): Promise<void> {
    await this.workers.correctBirthDate(id, dto.birthDate);
  }

  @RequirePermissions('workers.ban')
  @Post('workers/:id/ban')
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async unban(@Param('id', parseId()) id: string): Promise<void> {
    await this.workers.unban(id);
  }

  // Compliance (the compliance officer) -------------------------------------

  @RequirePermissions('workers.compliance')
  @Post('workers/:id/report-underage')
  @ApiCreatedResponse({ type: CaseCreatedView })
  async reportUnderage(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<CaseCreatedView> {
    return { caseId: await this.workers.reportUnderage(id, reasonOf(dto)) };
  }

  @RequirePermissions('workers.compliance')
  @Get('compliance-cases')
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async closeIncident(@Param('id', parseId()) id: string): Promise<void> {
    await this.workers.closeCardIncident(id);
  }
}
