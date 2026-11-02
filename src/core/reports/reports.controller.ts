import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../access/require-permissions.decorator';
import { ApiArea, NoStore } from '../common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { CompoundExportsService } from './compound-exports.service';
import { ReportSchedulesService } from './report-schedules.service';
import {
  CreateReportScheduleDto,
  ReportExportQueryDto,
  ReportQueryDto,
  ReportRunsQueryDto,
  UpdateReportScheduleDto,
} from './reports.dto';
import { REPORT_READERS } from './report-registry';
import { ReportsService } from './reports.service';
import {
  CompoundExportView,
  FileLinkView,
  ReportCatalogView,
  ReportRunView,
  ReportScheduleView,
  ReportView,
} from './reports.views';

/** The curated reports (ADR 0086): each by its own permission. */
@ApiArea('reports')
@RequireAnyPermission(...REPORT_READERS)
@Controller('staff/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({ summary: 'The reports I may read, and their groupings' })
  @ApiOkResponse({ type: ListOf(ReportCatalogView) })
  async catalog(): Promise<ListResponse<ReportCatalogView>> {
    return bounded(await this.reports.catalog(), ReportCatalogView.from);
  }

  @Get('view')
  @ApiOperation({
    summary:
      'A report over a period, grouped, compared with the period before and/or a year earlier',
  })
  @ApiOkResponse({ type: ReportView })
  async read(@Query() q: ReportQueryDto): Promise<ReportView> {
    const { report, ...rest } = q;
    return ReportView.from(await this.reports.read(report, rest));
  }

  @Get('export')
  @NoStore()
  @ApiProduces(
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
  )
  @ApiOperation({ summary: 'A report as a PDF, a workbook or CSV (audited)' })
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async export(@Query() q: ReportExportQueryDto): Promise<StreamableFile> {
    const { report, format, ...rest } = q;
    const file = await this.reports.export(report, rest, format);
    // Type and name travel with the stream, never through @Header (csvFile).
    return new StreamableFile(file.body, {
      type:
        file.contentType === 'text/csv'
          ? 'text/csv; charset=utf-8'
          : file.contentType,
      disposition: `attachment; filename="${file.name}"`,
      length: file.body.length,
    });
  }
}

/** Reports sent on a cadence (ADR 0086). */
@ApiArea('reports')
@RequirePermissions('reports.schedule')
@Controller('staff/report-schedules')
export class ReportSchedulesController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @Get()
  @ApiOperation({ summary: 'The compound’s report schedules' })
  @ApiOkResponse({ type: ListOf(ReportScheduleView) })
  async list(): Promise<ListResponse<ReportScheduleView>> {
    return bounded(await this.schedules.list(), ReportScheduleView.from);
  }

  @Post()
  @ApiOperation({
    summary:
      'Send a report daily, weekly or monthly to the staff who may read it',
  })
  @ApiCreatedResponse({ type: ReportScheduleView })
  async create(
    @Body() dto: CreateReportScheduleDto,
  ): Promise<ReportScheduleView> {
    return ReportScheduleView.from(await this.schedules.create(dto));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a schedule’s format, comparison or grouping, or pause it',
  })
  @ApiOkResponse({ type: ReportScheduleView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateReportScheduleDto,
  ): Promise<ReportScheduleView> {
    return ReportScheduleView.from(await this.schedules.update(id, dto));
  }
}

/** A schedule's runs, each a file to download (ADR 0086). */
@ApiArea('reports')
@RequireAnyPermission(...REPORT_READERS)
@Controller('staff/report-runs')
export class ReportRunsController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @Get()
  @ApiOperation({ summary: 'The runs of the reports I may read' })
  @ApiOkResponse({ type: ListOf(ReportRunView) })
  async list(
    @Query() q: ReportRunsQueryDto,
  ): Promise<ListResponse<ReportRunView>> {
    return toList(await this.schedules.runs(q), ReportRunView.from);
  }

  /** No-store: a presigned URL of the file. */
  @Get(':id/download')
  @NoStore()
  @ApiOperation({ summary: 'A short-lived download URL for a run’s file' })
  @ApiOkResponse({ type: FileLinkView })
  async download(@Param('id', parseId()) id: string): Promise<FileLinkView> {
    return FileLinkView.from(await this.schedules.download(id));
  }
}

/**
 * The compound's operational data as one archive (ADR 0086): a fresh
 * step-up on this session first (`POST /me/step-up`), once a day.
 */
@ApiArea('reports')
@RequirePermissions('compound.export')
@Controller('staff/compound-exports')
export class CompoundExportsController {
  constructor(private readonly exports: CompoundExportsService) {}

  @Post()
  @ApiOperation({
    summary: 'Export the compound’s operational data (step-up required)',
  })
  @ApiCreatedResponse({ type: CompoundExportView })
  async request(): Promise<CompoundExportView> {
    return CompoundExportView.from(await this.exports.request());
  }

  @Get()
  @ApiOperation({ summary: 'The compound’s latest exports' })
  @ApiOkResponse({ type: ListOf(CompoundExportView) })
  async list(): Promise<ListResponse<CompoundExportView>> {
    return bounded(await this.exports.latest(), CompoundExportView.from);
  }

  /** No-store: a presigned URL of the archive. */
  @Get(':id/download')
  @NoStore()
  @ApiOperation({ summary: 'A short-lived download URL for a ready export' })
  @ApiOkResponse({ type: FileLinkView })
  async download(@Param('id', parseId()) id: string): Promise<FileLinkView> {
    return FileLinkView.from(await this.exports.downloadUrl(id));
  }
}
