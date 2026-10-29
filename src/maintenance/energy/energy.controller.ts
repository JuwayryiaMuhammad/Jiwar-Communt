import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import { MeterAlertsService } from './alerts.service';
import {
  CheckReadingImportDto,
  CorrectReadingDto,
  CreateMeterDto,
  EnergySettingsDto,
  MeterAlertsQueryDto,
  MetersQueryDto,
  ReadingsQueryDto,
  RecordReadingDto,
  UpdateMeterDto,
} from './dto/energy.dto';
import { EnergySettingsService } from './energy-settings.service';
import { MetersService } from './meters.service';
import { MeterReadingImportsService } from './reading-imports.service';
import { ReadingsService } from './readings.service';
import {
  EnergySettingsView,
  MeterAlertView,
  MeterReadingImportView,
  MeterReadingView,
  MeterToReadView,
  MeterView,
} from './views/energy.views';

/** The compound's meters (ADR 0066). */
@ApiArea('maintenance')
@Controller('maintenance/meters')
export class MetersController {
  constructor(
    private readonly meters: MetersService,
    private readonly readings: ReadingsService,
  ) {}

  @Get()
  @RequirePermissions('energy.read')
  @ApiOperation({ summary: 'List the meters, oldest first' })
  @ApiOkResponse({ type: ListOf(MeterView) })
  async list(@Query() q: MetersQueryDto): Promise<ListResponse<MeterView>> {
    return toList(await this.meters.list(q), (m) => MeterView.from(m));
  }

  @Post()
  @RequirePermissions('energy.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Add a meter' })
  @ApiCreatedResponse({ type: MeterView })
  async create(@Body() dto: CreateMeterDto): Promise<MeterView> {
    return MeterView.from(await this.meters.create(dto));
  }

  @Get(':id')
  @RequirePermissions('energy.read')
  @ApiOperation({ summary: 'Get a meter' })
  @ApiOkResponse({ type: MeterView })
  async get(@Param('id', parseId()) id: string): Promise<MeterView> {
    return MeterView.from(await this.meters.get(id));
  }

  @Patch(':id')
  @RequirePermissions('energy.manage')
  @ApiOperation({ summary: 'Change a meter’s serial or installation day' })
  @ApiOkResponse({ type: MeterView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateMeterDto,
  ): Promise<MeterView> {
    return MeterView.from(await this.meters.update(id, dto));
  }

  /** `reasonCode` from the closed list `meterRetire`. */
  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('energy.manage')
  @ApiOperation({ summary: 'Retire a meter for good' })
  @ApiOkResponse({ type: MeterView })
  async retire(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<MeterView> {
    return MeterView.from(await this.meters.retire(id, dto.reasonCode));
  }

  @Get(':id/readings')
  @RequirePermissions('energy.read')
  @ApiOperation({ summary: 'A meter’s readings, the latest day first' })
  @ApiOkResponse({ type: ListOf(MeterReadingView) })
  async readingsOf(
    @Param('id', parseId()) id: string,
    @Query() q: ReadingsQueryDto,
  ): Promise<ListResponse<MeterReadingView>> {
    return toList(await this.readings.list(id, q), (r) =>
      MeterReadingView.from(r),
    );
  }

  @Post(':id/readings')
  @RequirePermissions('energy.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Enter a reading by hand' })
  @ApiCreatedResponse({ type: MeterReadingView })
  async record(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordReadingDto,
  ): Promise<MeterReadingView> {
    return MeterReadingView.from(await this.readings.record(id, dto, 'manual'));
  }

  /** `reasonCode` from the closed list `readingCorrect`; the new reading supersedes it. */
  @Post(':id/readings/:readingId/correct')
  @RequirePermissions('energy.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Correct a reading, once' })
  @ApiCreatedResponse({ type: MeterReadingView })
  async correct(
    @Param('id', parseId()) id: string,
    @Param('readingId', parseId('readingId')) readingId: string,
    @Body() dto: CorrectReadingDto,
  ): Promise<MeterReadingView> {
    return MeterReadingView.from(
      await this.readings.correct(id, readingId, dto),
    );
  }

  /** `reasonCode` from the closed list `readingCorrect`; nothing takes its place. */
  @Post(':id/readings/:readingId/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('energy.manage')
  @ApiOperation({ summary: 'Withdraw a reading, once' })
  @ApiOkResponse({ type: MeterReadingView })
  async withdraw(
    @Param('id', parseId()) id: string,
    @Param('readingId', parseId('readingId')) readingId: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<MeterReadingView> {
    return MeterReadingView.from(
      await this.readings.withdraw(id, readingId, dto.reasonCode),
    );
  }
}

/** The meters' spike alerts (ADR 0066). */
@ApiArea('maintenance')
@Controller('maintenance/meter-alerts')
export class MeterAlertsController {
  constructor(private readonly alerts: MeterAlertsService) {}

  @Get()
  @RequirePermissions('energy.read')
  @ApiOperation({ summary: 'The spike alerts, the newest first' })
  @ApiOkResponse({ type: ListOf(MeterAlertView) })
  async list(
    @Query() q: MeterAlertsQueryDto,
  ): Promise<ListResponse<MeterAlertView>> {
    return toList(await this.alerts.list(q), (a) => MeterAlertView.from(a));
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('energy.manage')
  @ApiOperation({ summary: 'Acknowledge an alert, once' })
  @ApiOkResponse({ type: MeterAlertView })
  async acknowledge(
    @Param('id', parseId()) id: string,
  ): Promise<MeterAlertView> {
    return MeterAlertView.from(await this.alerts.acknowledge(id));
  }
}

/** The compound's spike rule (ADR 0066). */
@ApiArea('maintenance')
@RequirePermissions('energy.manage')
@Controller('maintenance/energy/settings')
export class EnergySettingsController {
  constructor(private readonly settings: EnergySettingsService) {}

  @Get()
  @ApiOperation({ summary: 'The spike rule' })
  @ApiOkResponse({ type: EnergySettingsView })
  async get(): Promise<EnergySettingsView> {
    return EnergySettingsView.from(await this.settings.get());
  }

  @Patch()
  @ApiOperation({ summary: 'Change the spike rule' })
  @ApiOkResponse({ type: EnergySettingsView })
  async update(@Body() dto: EnergySettingsDto): Promise<EnergySettingsView> {
    return EnergySettingsView.from(await this.settings.update(dto));
  }
}

/**
 * The meters a technician reads (ADR 0066): the meter, its last reading
 * and the range today's is expected in — never its history or its use.
 */
@ApiArea('maintenance')
@RequirePermissions('meters.record')
@Controller('technician/meters')
export class TechnicianMetersController {
  constructor(private readonly readings: ReadingsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'A meter to read' })
  @ApiOkResponse({ type: MeterToReadView })
  async get(@Param('id', parseId()) id: string): Promise<MeterToReadView> {
    return MeterToReadView.from(await this.readings.toRead(id));
  }

  @Post(':id/readings')
  @Idempotent()
  @ApiOperation({ summary: 'Record a meter’s reading' })
  @ApiCreatedResponse({ type: MeterReadingView })
  async record(
    @Param('id', parseId()) id: string,
    @Body() dto: RecordReadingDto,
  ): Promise<MeterReadingView> {
    return MeterReadingView.from(
      await this.readings.record(id, dto, 'technician'),
    );
  }
}

/** Sheets of meter readings (ADR 0066): checked whole, applied once. */
@ApiArea('maintenance')
@RequirePermissions('energy.manage')
@Controller('maintenance/meter-reading-imports')
export class MeterReadingImportsController {
  constructor(private readonly imports: MeterReadingImportsService) {}

  @Get()
  @ApiOperation({ summary: 'The imports, the newest first' })
  @ApiOkResponse({ type: ListOf(MeterReadingImportView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<MeterReadingImportView>> {
    return toList(await this.imports.list(q), (i) =>
      MeterReadingImportView.from(i),
    );
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Check a sheet of readings' })
  @ApiCreatedResponse({ type: MeterReadingImportView })
  async check(
    @Body() dto: CheckReadingImportDto,
  ): Promise<MeterReadingImportView> {
    return MeterReadingImportView.from(await this.imports.check(dto.fileId));
  }

  @Get(':id')
  @ApiOperation({ summary: 'An import and its problems' })
  @ApiOkResponse({ type: MeterReadingImportView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<MeterReadingImportView> {
    return MeterReadingImportView.from(await this.imports.get(id));
  }

  /** Checked again under the meters' locks: every row is written, or the import turns invalid. */
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply a valid import, once' })
  @ApiOkResponse({ type: MeterReadingImportView })
  async apply(
    @Param('id', parseId()) id: string,
  ): Promise<MeterReadingImportView> {
    return MeterReadingImportView.from(await this.imports.apply(id));
  }
}
