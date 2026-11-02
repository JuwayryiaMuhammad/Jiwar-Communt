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
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  RecordUnitEntryDto,
  ReportUnitEntryDto,
  UnitEntriesQueryDto,
} from './dto/unit-entries.dto';
import { UnitEntriesService } from './unit-entries.service';
import { StaffUnitEntryView, UnitEntryView } from './views/unit-entry.views';

/**
 * Emergency entries into a unit (ADR 0083): recorded, the unit's people
 * told at once; reported once. Photos are presigned: never cached.
 */
@ApiArea('guard-duty')
@RequirePermissions('guard_tasks.manage')
@Controller('staff/security/unit-entries')
export class StaffUnitEntriesController {
  constructor(private readonly entries: UnitEntriesService) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Record an emergency entry into a unit' })
  @Idempotent()
  @ApiCreatedResponse({ type: StaffUnitEntryView })
  async record(@Body() dto: RecordUnitEntryDto): Promise<StaffUnitEntryView> {
    return StaffUnitEntryView.fromStaff(await this.entries.record(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Emergency entries, the newest first' })
  @ApiOkResponse({ type: ListOf(StaffUnitEntryView) })
  async list(
    @Query() q: UnitEntriesQueryDto,
  ): Promise<ListResponse<StaffUnitEntryView>> {
    return toList(await this.entries.list(q), (e) =>
      StaffUnitEntryView.fromStaff(e),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one emergency entry' })
  @ApiOkResponse({ type: StaffUnitEntryView })
  async get(@Param('id', parseId()) id: string): Promise<StaffUnitEntryView> {
    return StaffUnitEntryView.fromStaff(await this.entries.get(id));
  }

  @Post(':id/report')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report what an emergency entry found, once' })
  @ApiOkResponse({ type: StaffUnitEntryView })
  async report(
    @Param('id', parseId()) id: string,
    @Body() dto: ReportUnitEntryDto,
  ): Promise<StaffUnitEntryView> {
    return StaffUnitEntryView.fromStaff(await this.entries.report(id, dto));
  }
}

/** A unit's emergency entries, for its occupants and its proxies (ADR 0083). */
@ApiArea('units')
@RequirePermissions('units.read')
@Controller('units/:unitId/entries')
export class UnitEntriesController {
  constructor(private readonly entries: UnitEntriesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Emergency entries into the unit, newest first' })
  @ApiOkResponse({ type: [UnitEntryView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<UnitEntryView[]> {
    return (await this.entries.forUnit(unitId)).map((e) =>
      UnitEntryView.from(e),
    );
  }
}
