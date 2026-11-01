import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CheckUnitImportDto } from './dto/unit-imports.dto';
import { UnitImportsService } from './unit-imports.service';
import { UnitImportView } from './views/unit-import.view';

/** Sheets of units and residents (ADR 0072): checked whole, then applied once. */
@ApiArea('units')
@RequirePermissions('units.manage', 'residents.manage')
@Controller('staff/unit-imports')
export class UnitImportsController {
  constructor(private readonly imports: UnitImportsService) {}

  @Get()
  @ApiOperation({ summary: 'List unit and resident imports, newest first' })
  @ApiOkResponse({ type: ListOf(UnitImportView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<UnitImportView>> {
    return toList(await this.imports.list(q), (i) => UnitImportView.from(i));
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Check a sheet of units or residents' })
  @ApiCreatedResponse({ type: UnitImportView })
  async check(@Body() dto: CheckUnitImportDto): Promise<UnitImportView> {
    return UnitImportView.from(await this.imports.check(dto.kind, dto.fileId));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a unit or resident import' })
  @ApiOkResponse({ type: UnitImportView })
  async get(@Param('id', parseId()) id: string): Promise<UnitImportView> {
    return UnitImportView.from(await this.imports.get(id));
  }

  @Post(':id/apply')
  @ApiOperation({
    summary:
      'Apply a valid import of the last day: every row, or none (then it is invalid)',
  })
  @ApiCreatedResponse({ type: UnitImportView })
  async apply(@Param('id', parseId()) id: string): Promise<UnitImportView> {
    return UnitImportView.from(await this.imports.apply(id));
  }
}
