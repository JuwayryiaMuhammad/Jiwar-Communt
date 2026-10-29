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
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import {
  CreateMeterDto,
  MetersQueryDto,
  UpdateMeterDto,
} from './dto/energy.dto';
import { MetersService } from './meters.service';
import { MeterView } from './views/energy.views';

/** The compound's meters (ADR 0066). */
@ApiArea('maintenance')
@Controller('maintenance/meters')
export class MetersController {
  constructor(private readonly meters: MetersService) {}

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
}
