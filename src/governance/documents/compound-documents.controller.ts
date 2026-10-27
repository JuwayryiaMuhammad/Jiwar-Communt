import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { CompoundDocumentsService } from './compound-documents.service';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  CompoundDocumentVersionsQueryDto,
  NewCompoundDocumentVersionDto,
} from './dto/compound-documents.dto';
import {
  CompoundDocumentSummaryView,
  CompoundDocumentView,
} from './views/compound-document.views';

/** The compound's documents, as everyone reads them (ADR 0062). */
@ApiArea('governance')
@RequirePermissions('community.read')
@Controller('compound-documents')
export class CompoundDocumentsController {
  constructor(private readonly documents: CompoundDocumentsService) {}

  /** The latest version of each kind. */
  @Get()
  @ApiOperation({ summary: 'The compound’s documents, latest versions' })
  @ApiOkResponse({ type: [CompoundDocumentSummaryView] })
  async current(): Promise<CompoundDocumentSummaryView[]> {
    return (await this.documents.current()).map((d) =>
      CompoundDocumentSummaryView.from(d),
    );
  }

  @Get('versions')
  @ApiOperation({ summary: 'A compound document’s versions' })
  @ApiOkResponse({ type: [CompoundDocumentSummaryView] })
  async versions(
    @Query() q: CompoundDocumentVersionsQueryDto,
  ): Promise<CompoundDocumentSummaryView[]> {
    return (await this.documents.versions(q.kind)).map((d) =>
      CompoundDocumentSummaryView.from(d),
    );
  }

  @Get('versions/:id')
  @ApiOperation({ summary: 'One version of a compound document' })
  @NoStore()
  @ApiOkResponse({ type: CompoundDocumentView })
  async version(
    @Param('id', parseId()) id: string,
  ): Promise<CompoundDocumentView> {
    const { document, read } = await this.documents.version(id);
    return CompoundDocumentView.fromRead(document, read);
  }
}

/** Publishing the compound's documents, the management's side (ADR 0062). */
@ApiArea('governance')
@RequirePermissions('content.manage')
@Controller('staff/compound-documents')
export class StaffCompoundDocumentsController {
  constructor(private readonly documents: CompoundDocumentsService) {}

  /** The latest version of each kind, as the editor starts from it. */
  @Get()
  @ApiOperation({
    summary: 'The compound’s documents, latest versions (staff)',
  })
  @ApiOkResponse({ type: [CompoundDocumentSummaryView] })
  async current(): Promise<CompoundDocumentSummaryView[]> {
    return (await this.documents.current()).map((d) =>
      CompoundDocumentSummaryView.from(d),
    );
  }

  /** The bylaws need the board's published decision (boardPublicationId). */
  @Post('versions')
  @ApiOperation({ summary: 'Publish a new version of a compound document' })
  @ApiCreatedResponse({ type: CompoundDocumentView })
  async publish(
    @Body() dto: NewCompoundDocumentVersionDto,
  ): Promise<CompoundDocumentView> {
    return CompoundDocumentView.fromRead(
      await this.documents.publish(dto),
      null,
    );
  }
}
