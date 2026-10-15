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
  CreateAccessibilityRequestDto,
  CreateEscortRequestDto,
  CreateLaneRequestDto,
  CreateSecurityReportDto,
  MyGateServicesQueryDto,
} from './dto/gate-services.dto';
import { GateServicesService } from './gate-services.service';
import { GateServiceView } from './views/gate-service.views';

const LIMITS =
  'At most 3 open of a kind per unit, and 20 a day per unit (GATE_SERVICE_LIMIT_REACHED, params.scope `open` or `day`). Someone who lives in the unit asks (a landlord: GATE_SERVICE_NOT_ALLOWED).';

/** Gate services, the requester's side (ADR 0047, C7 and D1–D5). */
@ApiArea('gate-services')
@RequirePermissions('gate_services.request')
@Controller()
export class GateServicesController {
  constructor(private readonly services: GateServicesService) {}

  @Post('accessibility-requests')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Ask for accessibility help (C7)',
    description: `A wheelchair, someone to walk with, a golf cart or help with bags, for the caller or a household member. ${LIMITS}`,
  })
  @ApiCreatedResponse({ type: GateServiceView })
  async accessibility(
    @Body() dto: CreateAccessibilityRequestDto,
  ): Promise<GateServiceView> {
    return GateServiceView.from(
      await this.services.create({ kind: 'accessibility', ...dto }),
    );
  }

  @Post('security-reports')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Report something suspicious (D1)',
    description: LIMITS,
  })
  @ApiCreatedResponse({ type: GateServiceView })
  async suspicious(
    @Body() dto: CreateSecurityReportDto,
  ): Promise<GateServiceView> {
    return GateServiceView.from(
      await this.services.create({ kind: 'suspicious', ...dto }),
    );
  }

  @Post('escort-requests')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Ask for a security escort (D2)',
    description: LIMITS,
  })
  @ApiCreatedResponse({ type: GateServiceView })
  async escort(@Body() dto: CreateEscortRequestDto): Promise<GateServiceView> {
    return GateServiceView.from(
      await this.services.create({ kind: 'escort', ...dto }),
    );
  }

  @Post('lane-requests')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Ask a gate to open a lane (D3)',
    description: `The guards on shift at that gate are told first. ${LIMITS}`,
  })
  @ApiCreatedResponse({ type: GateServiceView })
  async lane(@Body() dto: CreateLaneRequestDto): Promise<GateServiceView> {
    const { reason, ...rest } = dto;
    return GateServiceView.from(
      await this.services.create({ kind: 'lane', laneReason: reason, ...rest }),
    );
  }

  @Get('me/gate-services')
  @NoStore()
  @ApiOperation({
    summary: 'List my gate service requests (D5)',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(GateServiceView) })
  async mine(
    @Query() q: MyGateServicesQueryDto,
  ): Promise<ListResponse<GateServiceView>> {
    return toList(await this.services.mine(q), (r) => GateServiceView.from(r));
  }

  @Get('gate-services/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of my gate service requests' })
  @ApiOkResponse({ type: GateServiceView })
  async get(@Param('id', parseId()) id: string): Promise<GateServiceView> {
    return GateServiceView.from(await this.services.get(id));
  }

  @Post('gate-services/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel my request while it is open',
    description: 'Once security accepted it: GATE_SERVICE_NOT_OPEN.',
  })
  @ApiOkResponse({ type: GateServiceView })
  async cancel(@Param('id', parseId()) id: string): Promise<GateServiceView> {
    return GateServiceView.from(await this.services.cancel(id));
  }
}
