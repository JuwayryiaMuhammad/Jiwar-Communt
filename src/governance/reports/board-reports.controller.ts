import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
} from '@nestjs/swagger';
import type { BoardReport } from '@prisma/client';
import { IsString, Matches } from 'class-validator';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { fromDate } from '../db-clock';
import { BoardReportsService, MONTH } from './board-reports.service';

export class GenerateBoardReportDto {
  @ApiProperty({
    type: String,
    pattern: MONTH.source,
    example: '2027-02',
    description:
      'The month, up to the current one (DAY_OUT_OF_RANGE): drawn again as its next version.',
  })
  @IsString()
  @Matches(MONTH)
  month: string;
}

export class BoardReportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: '2027-02' })
  month: string;
  @ApiProperty({
    type: Number,
    description: 'From 1; each drawing on demand adds one.',
  })
  version: number;
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'Written by the monthly run, not by anyone on demand.',
  })
  bySweep: boolean;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'governance: the board’s figures for the month (requests, appeals, polls, elections, meetings, action items); sections: the overview’s (finance’s money, security’s incidents and violations, ADR 0055). Totals only, never a name.',
  })
  contents: Record<string, unknown>;

  static from(r: BoardReport): BoardReportView {
    return {
      id: r.id,
      month: fromDate(r.period).slice(0, 7),
      version: r.version,
      generatedAt: r.generatedAt,
      bySweep: r.generatedById === null,
      contents: r.contents as Record<string, unknown>,
    };
  }
}

/** The board's monthly reports (ADR 0075). */
@ApiArea('governance')
@RequireAnyPermission('governance.board', 'governance.manage')
@Controller('board/reports')
export class BoardReportsController {
  constructor(private readonly reports: BoardReportsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'The board’s monthly reports, latest first' })
  @ApiOkResponse({ type: ListOf(BoardReportView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<BoardReportView>> {
    return toList(await this.reports.list(q), (r) => BoardReportView.from(r));
  }

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Draw a month’s report again',
    description:
      'A sitting member (BOARD_SEAT_REQUIRED) or the manager: the month’s next version, the earlier ones kept.',
  })
  @ApiCreatedResponse({ type: BoardReportView })
  async generate(
    @Body() dto: GenerateBoardReportDto,
  ): Promise<BoardReportView> {
    return BoardReportView.from(await this.reports.generate(dto.month));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read a board report' })
  @ApiOkResponse({ type: BoardReportView })
  async get(@Param('id', parseId()) id: string): Promise<BoardReportView> {
    return BoardReportView.from(await this.reports.get(id));
  }

  @Get(':id/pdf')
  @NoStore()
  @ApiOperation({
    summary: 'A board report as a PDF',
    description: 'With the compound’s logo when it has one.',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async pdf(@Param('id', parseId()) id: string): Promise<StreamableFile> {
    const { name, body } = await this.reports.drawPdf(id);
    return new StreamableFile(body, {
      type: 'application/pdf',
      disposition: `attachment; filename="${name}"`,
    });
  }
}
