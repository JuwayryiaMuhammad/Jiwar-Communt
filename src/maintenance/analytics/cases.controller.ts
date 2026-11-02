import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { CASE_STATUSES, CasesService, type CaseStatus } from './cases.service';
import {
  MaintenanceCaseDetailView,
  MaintenanceCaseView,
} from './analytics.views';

export class CasesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: CASE_STATUSES,
    enumName: 'MaintenanceCaseStatus',
  })
  @IsOptional()
  @IsIn(CASE_STATUSES, withParams({ allowed: [...CASE_STATUSES] }))
  status?: CaseStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  buildingId?: string;
}

/**
 * Community cases (ADR 0081), for the dispatch: opened by themselves when a
 * building's tickets of one category pass the compound's threshold; their
 * one work order is opened with `POST /maintenance/work-orders` (`caseId`).
 */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  @ApiOperation({ summary: 'List the community cases' })
  @ApiOkResponse({ type: ListOf(MaintenanceCaseView) })
  async list(
    @Query() q: CasesQueryDto,
  ): Promise<ListResponse<MaintenanceCaseView>> {
    return toList(await this.cases.list(q), (r) => MaintenanceCaseView.from(r));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a community case and its tickets' })
  @ApiOkResponse({ type: MaintenanceCaseDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<MaintenanceCaseDetailView> {
    return MaintenanceCaseDetailView.fromDetail(await this.cases.get(id));
  }

  /** `reasonCode` from `maintenanceCaseResolve`; each reporter is told. */
  @Post(':id/resolve')
  @ApiOperation({ summary: 'Resolve a community case' })
  @ApiOkResponse({ type: MaintenanceCaseDetailView })
  async resolve(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MaintenanceCaseDetailView> {
    return MaintenanceCaseDetailView.fromDetail(
      await this.cases.resolve(id, dto.reasonCode),
    );
  }

  /** `reasonCode` from `maintenanceCaseDismiss`; nobody is told. */
  @Post(':id/dismiss')
  @ApiOperation({ summary: 'Dismiss a community case' })
  @ApiOkResponse({ type: MaintenanceCaseDetailView })
  async dismiss(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<MaintenanceCaseDetailView> {
    return MaintenanceCaseDetailView.fromDetail(
      await this.cases.dismiss(id, dto.reasonCode),
    );
  }
}
