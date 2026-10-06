import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Public } from '../common/guards/public.decorator';
import { ApiArea, NoStore, PublicPageHeaders } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { DataExportsService } from './data-exports.service';
import { ExportDownloadDto, ExportLinkDto } from './dto/data-exports.dto';
import { DataExportView, DownloadView } from './views/data-export.views';

/**
 * The caller's own personal-data exports (ADR 0036); any tenant account.
 * A request needs a fresh step-up on this session (`POST /me/step-up`).
 */
@ApiArea('data-exports')
@Controller('me/data-exports')
export class DataExportsController {
  constructor(private readonly exports: DataExportsService) {}

  @Post()
  @ApiCreatedResponse({ type: DataExportView })
  async request(): Promise<DataExportView> {
    return DataExportView.from(await this.exports.request());
  }

  @Get()
  @ApiOkResponse({ type: ListOf(DataExportView) })
  async mine(): Promise<ListResponse<DataExportView>> {
    return bounded(await this.exports.mine(), (r) => DataExportView.from(r));
  }

  /** No-store: a presigned URL of the archive. */
  @Get(':id/download')
  @NoStore()
  @ApiOkResponse({ type: DownloadView })
  async download(@Param('id', parseId()) id: string): Promise<DownloadView> {
    return DownloadView.from(await this.exports.downloadUrl(id));
  }
}

/**
 * An assisted export's email link (ADR 0036): the link, then a code sent to
 * the account's own email, at most three downloads. No account; POST so
 * the token stays in bodies.
 */
@ApiArea('data-exports', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/data-exports')
export class PublicDataExportsController {
  constructor(private readonly exports: DataExportsService) {}

  @Post('code')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse()
  async code(@Body() dto: ExportLinkDto, @Ip() ip: string): Promise<void> {
    await this.exports.sendDownloadCode(dto.token, ip);
  }

  @Post('download')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: DownloadView })
  async download(
    @Body() dto: ExportDownloadDto,
    @Ip() ip: string,
  ): Promise<DownloadView> {
    return DownloadView.from(
      await this.exports.downloadByToken(dto.token, dto.code, ip),
    );
  }
}
