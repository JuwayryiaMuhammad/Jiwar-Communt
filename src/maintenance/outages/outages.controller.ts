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
import { CreateOutageDto, UpdateOutageDto } from './dto/outages.dto';
import { OutagesService } from './outages.service';
import { MyOutageView, OutageView } from './views/outage.views';

/** Utility outages (ADR 0066), told to the residents of their buildings. */
@ApiArea('maintenance')
@Controller('maintenance/outages')
export class OutagesController {
  constructor(private readonly outages: OutagesService) {}

  @Get()
  @RequirePermissions('energy.read')
  @ApiOperation({ summary: 'The outages, the latest start first' })
  @ApiOkResponse({ type: ListOf(OutageView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<OutageView>> {
    return toList(await this.outages.list(q), (o) => OutageView.from(o));
  }

  @Post()
  @RequirePermissions('energy.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Enter an outage; its residents are told' })
  @ApiCreatedResponse({ type: OutageView })
  async create(@Body() dto: CreateOutageDto): Promise<OutageView> {
    return OutageView.from(await this.outages.create(dto));
  }

  @Get(':id')
  @RequirePermissions('energy.read')
  @ApiOperation({ summary: 'Get an outage' })
  @ApiOkResponse({ type: OutageView })
  async get(@Param('id', parseId()) id: string): Promise<OutageView> {
    return OutageView.from(await this.outages.get(id));
  }

  @Patch(':id')
  @RequirePermissions('energy.manage')
  @ApiOperation({
    summary:
      'Change its buildings, its end, its note, or its start before it starts',
  })
  @ApiOkResponse({ type: OutageView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateOutageDto,
  ): Promise<OutageView> {
    return OutageView.from(await this.outages.update(id, dto));
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('energy.manage')
  @ApiOperation({ summary: 'It is over: those told are told' })
  @ApiOkResponse({ type: OutageView })
  async end(@Param('id', parseId()) id: string): Promise<OutageView> {
    return OutageView.from(await this.outages.end(id));
  }

  /** `reasonCode` from the closed list `outageCancel`; only before it starts. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('energy.manage')
  @ApiOperation({ summary: 'Call it off before it starts' })
  @ApiOkResponse({ type: OutageView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<OutageView> {
    return OutageView.from(await this.outages.cancel(id, dto.reasonCode));
  }
}

/** The outages a resident was told of, still to come or going on (ADR 0066). */
@ApiArea('me')
@Controller('me/outages')
export class MyOutagesController {
  constructor(private readonly outages: OutagesService) {}

  @Get()
  @ApiOperation({ summary: 'The outages I was told of that have not ended' })
  @ApiOkResponse({ type: [MyOutageView] })
  async mine(): Promise<MyOutageView[]> {
    return (await this.outages.mine()).map((o) => MyOutageView.from(o));
  }
}
