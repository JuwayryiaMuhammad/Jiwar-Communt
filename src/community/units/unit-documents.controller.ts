import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { NewUnitDocumentDto } from './dto/unit-documents.dto';
import { UnitDocumentsService } from './unit-documents.service';
import {
  UnitDocumentReadView,
  UnitDocumentView,
} from './views/unit-document.views';

/** A unit's document vault, the residents' side (ADR 0062). */
@ApiArea('units')
@RequirePermissions('units.read')
@Controller('units/:unitId/documents')
export class UnitDocumentsController {
  constructor(private readonly documents: UnitDocumentsService) {}

  /** What the caller may see, newest first; no URLs. */
  @Get()
  @ApiOperation({ summary: 'List the unit’s documents' })
  @ApiOkResponse({ type: [UnitDocumentView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<UnitDocumentView[]> {
    return (await this.documents.list(unitId)).map((d) =>
      UnitDocumentView.from(d),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Open a unit document' })
  @NoStore()
  @ApiOkResponse({ type: UnitDocumentReadView })
  async open(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<UnitDocumentReadView> {
    return UnitDocumentReadView.fromRead(await this.documents.open(unitId, id));
  }

  /** At most 50 live per unit (UNIT_DOCUMENT_LIMIT). */
  @Post()
  @ApiOperation({ summary: 'File a document in the unit’s vault' })
  @ApiCreatedResponse({ type: UnitDocumentView })
  async add(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewUnitDocumentDto,
  ): Promise<UnitDocumentView> {
    return UnitDocumentView.from(await this.documents.add(unitId, dto));
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a unit document of mine' })
  @ApiNoContentResponse()
  async remove(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<void> {
    await this.documents.remove(unitId, id);
  }
}

/** A unit's own documents, the management's side (ADR 0062). */
@ApiArea('units')
@RequirePermissions('unit_documents.manage')
@Controller('staff/units/:unitId/documents')
export class StaffUnitDocumentsController {
  constructor(private readonly documents: UnitDocumentsService) {}

  /** The unit's own and the registrants' proofs; never a resident's upload. */
  @Get()
  @ApiOperation({ summary: 'List a unit’s documents the management keeps' })
  @ApiOkResponse({ type: [UnitDocumentView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<UnitDocumentView[]> {
    return (await this.documents.staffList(unitId)).map((d) =>
      UnitDocumentView.from(d),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Open a unit document the management keeps' })
  @NoStore()
  @ApiOkResponse({ type: UnitDocumentReadView })
  async open(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<UnitDocumentReadView> {
    return UnitDocumentReadView.fromRead(
      await this.documents.staffOpen(unitId, id),
    );
  }

  @Post()
  @ApiOperation({ summary: 'File a unit document as the management' })
  @ApiCreatedResponse({ type: UnitDocumentView })
  async add(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewUnitDocumentDto,
  ): Promise<UnitDocumentView> {
    return UnitDocumentView.from(await this.documents.staffAdd(unitId, dto));
  }

  @Post(':id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a unit document of the management’s' })
  @ApiNoContentResponse()
  async remove(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<void> {
    await this.documents.staffRemove(unitId, id);
  }
}
