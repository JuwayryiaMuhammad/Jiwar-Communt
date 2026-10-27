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
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  RecommendReplacementDto,
  RecordReadingsDto,
  ReplacementsQueryDto,
  ReportFaultDto,
  TagScanDto,
} from './dto/field.dto';
import { FieldWorkService } from './field-work.service';
import { ReplacementsService } from './replacements.service';
import {
  FaultCreatedView,
  FieldAssetView,
  ReplacementRecommendationView,
  ScanResultView,
  UpcomingWorkView,
} from './views/field.views';

/** The technician in the field (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('assets.read')
@Controller('technician')
export class FieldController {
  constructor(private readonly field: FieldWorkService) {}

  @Post('scan')
  @ApiOperation({
    summary: 'Scan an asset’s or an area’s tag: its card; sixty a minute',
  })
  @ApiCreatedResponse({ type: ScanResultView })
  async scan(@Body() dto: TagScanDto): Promise<ScanResultView> {
    return ScanResultView.from(await this.field.scan(dto.code));
  }

  @Get('assets/:id')
  @ApiOperation({ summary: 'An asset’s card on site: history and readings' })
  @ApiOkResponse({ type: FieldAssetView })
  async card(@Param('id', parseId()) id: string): Promise<FieldAssetView> {
    return FieldAssetView.from(await this.field.card(id));
  }

  @Post('assets/:id/readings')
  @Idempotent()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Record readings of an asset' })
  @ApiNoContentResponse()
  record(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordReadingsDto,
  ): Promise<void> {
    return this.field.record(id, dto.readings);
  }

  @Post('assets/:id/faults')
  @Idempotent()
  @ApiOperation({ summary: 'Report a fault found on an asset: a work order' })
  @ApiCreatedResponse({ type: FaultCreatedView })
  fault(
    @Param('id', parseId()) id: string,
    @Body() dto: ReportFaultDto,
  ): Promise<FaultCreatedView> {
    return this.field.fault(id, dto);
  }

  @Post('assets/:id/replacement-recommendations')
  @Idempotent()
  @ApiOperation({
    summary:
      'Recommend replacing an asset; `reasonCode` from `replacementReason`',
  })
  @ApiCreatedResponse({ type: ReplacementRecommendationView })
  async recommend(
    @Param('id', parseId()) id: string,
    @Body() dto: RecommendReplacementDto,
  ): Promise<ReplacementRecommendationView> {
    return ReplacementRecommendationView.from(
      await this.field.recommend(id, dto),
    );
  }

  @Get('plans/upcoming')
  @ApiOperation({
    summary:
      'Planned work coming in my trade, within 30 days, and mine already',
  })
  @ApiOkResponse({ type: ListOf(UpcomingWorkView) })
  async upcoming(): Promise<ListResponse<UpcomingWorkView>> {
    return bounded(await this.field.upcoming(), (u) =>
      UpcomingWorkView.from(u),
    );
  }
}

/** The technicians' recommendations to replace (ADR 0064). */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/replacement-recommendations')
export class ReplacementsController {
  constructor(private readonly replacements: ReplacementsService) {}

  @Get()
  @ApiOperation({ summary: 'List recommendations to replace, newest first' })
  @ApiOkResponse({ type: ListOf(ReplacementRecommendationView) })
  async list(
    @Query() q: ReplacementsQueryDto,
  ): Promise<ListResponse<ReplacementRecommendationView>> {
    return toList(await this.replacements.list(q), (r) =>
      ReplacementRecommendationView.from(r),
    );
  }

  @Post(':id/accept')
  @ApiOperation({ summary: 'Accept a recommendation to replace' })
  @ApiCreatedResponse({ type: ReplacementRecommendationView })
  async accept(
    @Param('id', parseId()) id: string,
  ): Promise<ReplacementRecommendationView> {
    return ReplacementRecommendationView.from(
      await this.replacements.decide(id, { accept: true }),
    );
  }

  @Post(':id/decline')
  @ApiOperation({
    summary: 'Decline a recommendation; `reasonCode` from `replacementDecline`',
  })
  @ApiCreatedResponse({ type: ReplacementRecommendationView })
  async decline(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<ReplacementRecommendationView> {
    return ReplacementRecommendationView.from(
      await this.replacements.decide(id, {
        accept: false,
        reasonCode: dto.reasonCode,
      }),
    );
  }
}
