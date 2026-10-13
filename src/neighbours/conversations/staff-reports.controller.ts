import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CloseReportDto, ReportsQueryDto } from './dto/conversations.dto';
import { ReportsService } from './reports.service';
import {
  ReportedMessageView,
  StaffReportView,
} from './views/conversation.views';

/**
 * Reported conversations, for the staff (ADR 0042). There is no route
 * from here, or from anywhere, to a conversation nobody reported. Every
 * answer is no-store.
 */
@ApiArea('neighbours')
@RequirePermissions('neighbours.handle')
@Controller('neighbours/reports')
export class StaffReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List reported conversations' })
  @ApiOkResponse({ type: ListOf(StaffReportView) })
  async list(
    @Query() q: ReportsQueryDto,
  ): Promise<ListResponse<StaffReportView>> {
    return toList(await this.reports.listForStaff(q), (r) =>
      StaffReportView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a reported conversation’s case' })
  @ApiOkResponse({ type: StaffReportView })
  async get(@Param('id', parseId()) id: string): Promise<StaffReportView> {
    return StaffReportView.from(await this.reports.getForStaff(id));
  }

  /** Only while the case is open; each reading is audited. */
  @Get(':id/messages')
  @NoStore()
  @ApiOperation({ summary: 'Read the reported conversation of an open case' })
  @ApiOkResponse({ type: ListOf(ReportedMessageView) })
  async thread(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<ReportedMessageView>> {
    return toList(await this.reports.thread(id, q), (m) =>
      ReportedMessageView.from(m),
    );
  }

  @Post(':id/close')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Close a reported conversation’s case' })
  @ApiNoContentResponse()
  async close(
    @Param('id', parseId()) id: string,
    @Body() dto: CloseReportDto,
  ): Promise<void> {
    await this.reports.close(id, dto.reasonCode);
  }
}
