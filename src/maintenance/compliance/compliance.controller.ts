import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import { ComplianceService } from './compliance.service';
import {
  AddEvidenceDto,
  CompleteOccurrenceDto,
  ComplianceCalendarQueryDto,
  ComplianceItemsQueryDto,
  ComplianceSettingsDto,
  CreateComplianceItemDto,
  UpdateComplianceItemDto,
} from './dto/compliance.dto';
import {
  ComplianceArchiveView,
  ComplianceCalendarEntryView,
  ComplianceCalendarView,
  ComplianceItemDetailView,
  ComplianceItemView,
  ComplianceReportView,
  ComplianceSettingsView,
} from './views/compliance.views';

/**
 * The compliance calendar (ADR 0087): `compliance.manage`, the manager's by
 * default. What the compound keeps valid, its due days and their evidence,
 * the calendar with the vendors' papers in it, the status report and the
 * lead times.
 */
@ApiArea('maintenance')
@RequirePermissions('compliance.manage')
@Controller('staff/compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('items')
  @ApiOperation({
    summary: 'List the compliance items',
    description:
      'In the order they were made, each with its open due day and its state today.',
  })
  @ApiOkResponse({ type: ListOf(ComplianceItemView) })
  async list(
    @Query() q: ComplianceItemsQueryDto,
  ): Promise<ListResponse<ComplianceItemView>> {
    return toList(await this.compliance.list(q), (r) =>
      ComplianceItemView.from(r),
    );
  }

  @Post('items')
  @Idempotent()
  @ApiOperation({
    summary: 'Add a compliance item',
    description:
      'Its first due day is made with it. The responsible staff member is told.',
  })
  @ApiCreatedResponse({ type: ComplianceItemDetailView })
  async create(
    @Body() dto: CreateComplianceItemDto,
  ): Promise<ComplianceItemDetailView> {
    return ComplianceItemDetailView.fromDetail(
      await this.compliance.create(dto),
    );
  }

  @Get('items/:id')
  @ApiOperation({
    summary: 'Get a compliance item',
    description: 'With its due days, the latest first, and their evidence.',
  })
  @ApiOkResponse({ type: ComplianceItemDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ComplianceItemDetailView> {
    return ComplianceItemDetailView.fromDetail(await this.compliance.get(id));
  }

  @Patch('items/:id')
  @ApiOperation({
    summary: 'Change a compliance item',
    description: '`nextDueOn` moves its open due day; its notices start again.',
  })
  @ApiOkResponse({ type: ComplianceItemDetailView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateComplianceItemDto,
  ): Promise<ComplianceItemDetailView> {
    return ComplianceItemDetailView.fromDetail(
      await this.compliance.update(id, dto),
    );
  }

  /** `reasonCode` from the closed list `complianceRetire`. */
  @Post('items/:id/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire a compliance item',
    description: 'Once: its open due day is called off.',
  })
  @ApiOkResponse({ type: ComplianceItemDetailView })
  async retire(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<ComplianceItemDetailView> {
    return ComplianceItemDetailView.fromDetail(
      await this.compliance.retire(id, dto.reasonCode),
    );
  }

  @Post('occurrences/:occurrenceId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a due day done',
    description:
      'Once (COMPLIANCE_OCCURRENCE_ENDED after), with what it gave and its evidence. The next due day is made: the one given, else the expiry, else so many months on; none for an item done once.',
  })
  @ApiOkResponse({ type: ComplianceItemDetailView })
  async complete(
    @Param('occurrenceId', parseId('occurrenceId')) id: string,
    @Body() dto: CompleteOccurrenceDto,
  ): Promise<ComplianceItemDetailView> {
    return ComplianceItemDetailView.fromDetail(
      await this.compliance.complete(id, dto),
    );
  }

  @Post('occurrences/:occurrenceId/evidence')
  @ApiOperation({
    summary: 'File evidence on a due day',
    description: 'Open or done, 20 live files at most.',
  })
  @ApiCreatedResponse({ type: ComplianceArchiveView })
  async addEvidence(
    @Param('occurrenceId', parseId('occurrenceId')) id: string,
    @Body() dto: AddEvidenceDto,
  ): Promise<ComplianceArchiveView> {
    return ComplianceArchiveView.fromRead(
      await this.compliance.addEvidence(id, dto.fileId),
    );
  }

  @Delete('evidence/:evidenceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove evidence filed by mistake' })
  @ApiNoContentResponse()
  async removeEvidence(
    @Param('evidenceId', parseId('evidenceId')) id: string,
  ): Promise<void> {
    await this.compliance.removeEvidence(id);
  }

  @Get('calendar')
  @ApiOperation({
    summary: 'The compliance calendar',
    description:
      'The due days of the days asked (90 by default, 366 at most) and the vendors’ papers expiring then, by day.',
  })
  @ApiOkResponse({ type: ComplianceCalendarView })
  async calendar(
    @Query() q: ComplianceCalendarQueryDto,
  ): Promise<ComplianceCalendarView> {
    const c = await this.compliance.calendarOf(q);
    return {
      ...c,
      entries: c.entries.map((e) => ComplianceCalendarEntryView.from(e)),
    };
  }

  @Get('report')
  @NoStore()
  @ApiOperation({
    summary: 'The compliance status report',
    description:
      'Per kind, how many items are valid, due soon, overdue, done once or retired today; and the vendors’ papers. Counts only.',
  })
  @ApiOkResponse({ type: ComplianceReportView })
  async report(): Promise<ComplianceReportView> {
    return ComplianceReportView.from(await this.compliance.report());
  }

  @Get('report/export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export the compliance status as CSV',
    description:
      'UTF-8 with a byte-order mark, CRLF; one row per item not retired, the soonest due first.',
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(): Promise<StreamableFile> {
    const { name, body } = await this.compliance.reportCsv();
    return csvFile(name, body);
  }

  @Get('settings')
  @ApiOperation({ summary: 'The compound’s compliance lead times' })
  @ApiOkResponse({ type: ComplianceSettingsView })
  settings(): Promise<ComplianceSettingsView> {
    return this.compliance.settings();
  }

  @Put('settings')
  @ApiOperation({
    summary: 'Set the compound’s compliance lead times',
    description: 'One to three, 1 to 365 days each; 60, 30 and 7 by default.',
  })
  @ApiOkResponse({ type: ComplianceSettingsView })
  updateSettings(
    @Body() dto: ComplianceSettingsDto,
  ): Promise<ComplianceSettingsView> {
    return this.compliance.updateSettings(dto.leadDays);
  }
}
