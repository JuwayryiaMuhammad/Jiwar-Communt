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
  ApiProperty,
} from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  LogMaterialEntryDto,
  MaterialEntriesQueryDto,
  StopWorkDto,
} from './dto/permits.dto';
import { GatePermitsService } from './gate-permits.service';
import { MaterialEntriesService } from './material-entries.service';
import { GatePermitView } from './views/gate-permit.views';
import { MaterialEntryView } from './views/material-entry.views';
import { toList } from '../../core/common/http/list';
import { PermitWorkStopsService } from './permit-work-stops.service';
import { GuardWorkStopView } from './views/permit.views';

export class GatePermitsQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    example: 'B-12',
    description: 'A unit’s code: its permits in force today.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  unitCode?: string;

  @ApiProperty({
    type: String,
    required: false,
    example: 'W-0042',
    description:
      'A permit’s reference, as the household shows it (`W-42` and `w42` too). Exactly one of the two.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 16, withParams({ min: 1, max: 16 }))
  reference?: string;
}

/** The units' permits at the gate (ADR 0049), inside a shift. */
@ApiArea('permits')
@RequirePermissions('gate.operate')
@Controller('gate/unit-permits')
export class GatePermitsController {
  constructor(
    private readonly permits: GatePermitsService,
    private readonly stops: PermitWorkStopsService,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Find the permits in force today',
    description:
      'By a unit’s code or a permit’s reference: approved permits whose window touches today. No faces here: open one. Rate-limited and audited on the shift.',
  })
  @ApiOkResponse({ type: ListOf(GatePermitView) })
  async find(
    @Query() q: GatePermitsQueryDto,
  ): Promise<ListResponse<GatePermitView>> {
    return bounded(await this.permits.find(q), (r) => GatePermitView.from(r));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a permit at the gate',
    description:
      'In force today, or with someone of it inside. The workers’ faces (never the last four of their ID), the truck, the goods, and the guest list while the event is on. Then record entries with `POST /gate/entries`.',
  })
  @ApiOkResponse({ type: GatePermitView })
  async get(@Param('id', parseId()) id: string): Promise<GatePermitView> {
    return GatePermitView.from(await this.permits.get(id));
  }

  @Post(':id/stop-work')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Stop the work of a works permit',
    description:
      'A guard on shift, at a gate or in a zone (ADR 0053), with a code from `permitWorkStop`: an approved works permit in force (PERMIT_NOT_ACTIVE otherwise). Its workers are refused at the gate (`work_stopped`) until the management resumes it. The requester, the primary and the permits’ staff are told.',
  })
  @ApiOkResponse({ type: GuardWorkStopView })
  async stopWork(
    @Param('id', parseId()) id: string,
    @Body() dto: StopWorkDto,
  ): Promise<GuardWorkStopView> {
    return GuardWorkStopView.from(
      await this.stops.stop(id, dto.reasonCode, 'guard'),
    );
  }

  @Post(':id/use')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Let a material exit’s goods out, once',
    description:
      'After checking the goods against the items and the photo. Refused like an entry (GATE_ENTRY_REFUSED, params.reason `used`, `not_approved`, `not_yet_valid`, `expired`, `cancelled`, `revoked`): one use, whichever gate. The requester is told.',
  })
  @ApiOkResponse({ type: GatePermitView })
  async use(@Param('id', parseId()) id: string): Promise<GatePermitView> {
    return GatePermitView.from(await this.permits.use(id));
  }
}

/** Materials brought in, as the guard logs them (ADR 0049). */
@ApiArea('permits')
@Controller()
export class MaterialEntriesController {
  constructor(private readonly entries: MaterialEntriesService) {}

  @Post('gate/material-entries')
  @RequirePermissions('gate.operate')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Log materials brought in',
    description:
      'No permit is needed to bring materials in: the guard writes what came, for which unit, and its works permit when there is one. Taking them out needs a material exit.',
  })
  @ApiCreatedResponse({ type: MaterialEntryView })
  async log(@Body() dto: LogMaterialEntryDto): Promise<MaterialEntryView> {
    return MaterialEntryView.from(await this.entries.log(dto));
  }

  @Get('staff/material-entries')
  @RequirePermissions('permits.manage')
  @NoStore()
  @ApiOperation({
    summary: 'Read the materials log',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(MaterialEntryView) })
  async list(
    @Query() q: MaterialEntriesQueryDto,
  ): Promise<ListResponse<MaterialEntryView>> {
    return toList(await this.entries.list(q), (r) => MaterialEntryView.from(r));
  }
}
