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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { DocumentsService } from './documents.service';
import { AddDocumentDto, DocumentSubjectDto } from './dto/documents.dto';
import { MaintenanceDocumentView } from './views/document.views';

/** The register's documents (ADR 0064). */
@ApiArea('maintenance')
@Controller('maintenance/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** No-store: each document carries a presigned URL. */
  @Get()
  @NoStore()
  @RequirePermissions('assets.read')
  @ApiOperation({
    summary: 'List the documents of an asset, an asset type or a common area',
  })
  @ApiOkResponse({ type: ListOf(MaintenanceDocumentView) })
  async list(
    @Query() q: DocumentSubjectDto,
  ): Promise<ListResponse<MaintenanceDocumentView>> {
    return bounded(await this.documents.list(q), (d) =>
      MaintenanceDocumentView.from(d),
    );
  }

  /** No-store: the answer carries a presigned URL. */
  @Post()
  @NoStore()
  @RequirePermissions('assets.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Add a document' })
  @ApiCreatedResponse({ type: MaintenanceDocumentView })
  async add(@Body() dto: AddDocumentDto): Promise<MaintenanceDocumentView> {
    const { fileId, kind, title, ...subject } = dto;
    return MaintenanceDocumentView.from(
      await this.documents.add(subject, { fileId, kind, title }),
    );
  }

  @Post(':id/remove')
  @HttpCode(204)
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Remove a document (its file is deleted)' })
  @ApiNoContentResponse()
  remove(@Param('id', parseId()) id: string): Promise<void> {
    return this.documents.remove(id);
  }
}
