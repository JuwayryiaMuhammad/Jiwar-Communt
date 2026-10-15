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
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  AcceptGateServiceDto,
  CloseGateServiceDto,
  StaffGateServicesQueryDto,
} from './dto/gate-services.dto';
import { GateServiceHandlersService } from './gate-service-handlers.service';
import { StaffGateServiceView } from './views/gate-service.views';

/**
 * Gate services, security's side (ADR 0047): a guard inside an open shift
 * (`gate.operate`) or a `gate_services.handle` holder (the dashboard queue).
 */
@ApiArea('gate-services')
@RequireAnyPermission('gate.operate', 'gate_services.handle')
@Controller('gate/gate-services')
export class GateServiceHandlersController {
  constructor(
    private readonly handlers: GateServiceHandlersService,
    private readonly ctx: RequestContext,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the gate service requests',
    description:
      '`status=open` is the queue, oldest first. A guard needs an open shift (NO_OPEN_SHIFT).',
  })
  @ApiOkResponse({ type: ListOf(StaffGateServiceView) })
  async list(
    @Query() q: StaffGateServicesQueryDto,
  ): Promise<ListResponse<StaffGateServiceView>> {
    const me = this.ctx.accountId;
    return toList(await this.handlers.list(q), (r) =>
      StaffGateServiceView.from(r, me),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a gate service request' })
  @ApiOkResponse({ type: StaffGateServiceView })
  async get(@Param('id', parseId()) id: string): Promise<StaffGateServiceView> {
    return StaffGateServiceView.from(
      await this.handlers.get(id),
      this.ctx.accountId,
    );
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Accept an open request',
    description:
      'With the minutes you expect to take for accessibility help and an escort. The first wins (GATE_SERVICE_NOT_OPEN for the others); the requester is told.',
  })
  @ApiOkResponse({ type: StaffGateServiceView })
  async accept(
    @Param('id', parseId()) id: string,
    @Body() dto: AcceptGateServiceDto,
  ): Promise<StaffGateServiceView> {
    return StaffGateServiceView.from(
      await this.handlers.accept(id, dto.etaMinutes),
      this.ctx.accountId,
    );
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Start a request you accepted' })
  @ApiOkResponse({ type: StaffGateServiceView })
  async start(
    @Param('id', parseId()) id: string,
  ): Promise<StaffGateServiceView> {
    return StaffGateServiceView.from(
      await this.handlers.start(id),
      this.ctx.accountId,
    );
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Close a request',
    description:
      'An open one: anyone here (a duplicate, say). One accepted: its handler, or a `gate_services.handle` holder. The requester is told.',
  })
  @ApiOkResponse({ type: StaffGateServiceView })
  async close(
    @Param('id', parseId()) id: string,
    @Body() dto: CloseGateServiceDto,
  ): Promise<StaffGateServiceView> {
    return StaffGateServiceView.from(
      await this.handlers.close(id, dto),
      this.ctx.accountId,
    );
  }
}
