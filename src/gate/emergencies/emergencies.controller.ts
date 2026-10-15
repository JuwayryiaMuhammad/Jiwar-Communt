import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CancelEmergencyDto,
  MyEmergenciesQueryDto,
  ReportEmergencyDto,
} from './dto/emergencies.dto';
import { EmergenciesService } from './emergencies.service';
import { EmergencyView } from './views/emergency.views';

/** Emergencies, the household's side (ADR 0047, C1–C3). */
@ApiArea('emergencies')
@RequirePermissions('emergencies.report')
@Controller()
export class EmergenciesController {
  constructor(private readonly emergencies: EmergenciesService) {}

  @Post('emergencies')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Report an emergency',
    description:
      'Never rate-limited. Security is told at once (a critical push), and the others who live in the unit too. One open per unit and type: a repeat answers 200 with the open one.',
  })
  @ApiCreatedResponse({ type: EmergencyView })
  @ApiOkResponse({ type: EmergencyView, description: 'The open one.' })
  async report(
    @Body() dto: ReportEmergencyDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EmergencyView> {
    const { record, created } = await this.emergencies.report(dto);
    if (!created) res.status(HttpStatus.OK);
    return EmergencyView.from(record);
  }

  @Get('me/emergencies')
  @NoStore()
  @ApiOperation({
    summary: 'List the emergencies I reported or was alerted to',
    description: 'Newest first; `status=open` to resume one after a restart.',
  })
  @ApiOkResponse({ type: ListOf(EmergencyView) })
  async mine(
    @Query() q: MyEmergenciesQueryDto,
  ): Promise<ListResponse<EmergencyView>> {
    return toList(await this.emergencies.mine(q), (r) => EmergencyView.from(r));
  }

  @Get('emergencies/:id')
  @NoStore()
  @ApiOperation({ summary: 'Follow an emergency' })
  @ApiOkResponse({ type: EmergencyView })
  async get(@Param('id', parseId()) id: string): Promise<EmergencyView> {
    return EmergencyView.from(await this.emergencies.get(id));
  }

  @Post('emergencies/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel an open emergency',
    description:
      'Its reporter or the unit’s primary; a reason code is optional. Whoever was going is told.',
  })
  @ApiOkResponse({ type: EmergencyView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelEmergencyDto,
  ): Promise<EmergencyView> {
    return EmergencyView.from(
      await this.emergencies.cancel(id, dto.reasonCode),
    );
  }

  @Post('emergencies/:id/on-my-way')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Answer “on my way” to an emergency at home',
    description: 'For those who were alerted; once.',
  })
  @ApiOkResponse({ type: EmergencyView })
  async onMyWay(@Param('id', parseId()) id: string): Promise<EmergencyView> {
    return EmergencyView.from(await this.emergencies.onMyWay(id));
  }
}
