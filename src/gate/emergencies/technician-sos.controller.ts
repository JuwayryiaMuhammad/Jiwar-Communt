import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CancelEmergencyDto, RaiseSosDto } from './dto/emergencies.dto';
import { TechnicianSosService } from './technician-sos.service';
import { StaffEmergencyView } from './views/staff-emergency.views';

/** A technician's SOS from the ticket in their hands (ADR 0067), with no shift. */
@ApiArea('emergencies')
@RequirePermissions('tickets.work')
@Controller('technician/tickets/:id/sos')
export class TechnicianSosController {
  constructor(
    private readonly sos: TechnicianSosService,
    private readonly ctx: RequestContext,
  ) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Raise an SOS from your ticket',
    description:
      'From the ticket in your hands (TICKET_NOT_FOUND otherwise). The guards on shift, the responders and the management are told at once (a critical push); nobody’s family is. One open per ticket: a repeat answers 200 with the open one.',
  })
  @ApiCreatedResponse({ type: StaffEmergencyView })
  @ApiOkResponse({ type: StaffEmergencyView, description: 'The open one.' })
  async raise(
    @Param('id', parseId()) id: string,
    @Body() dto: RaiseSosDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffEmergencyView> {
    const { record, created } = await this.sos.raise(id, dto.type);
    if (!created) res.status(HttpStatus.OK);
    return StaffEmergencyView.from(record, this.ctx.accountId);
  }

  @Post('cancel-request')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Ask for the SOS you raised from this ticket to be called off',
    description:
      'With a code from `emergencyCancel` or none. Recorded once and told to the responders; it stays open until a responder or the management resolves it. EMERGENCY_NOT_FOUND when none of yours is open.',
  })
  @ApiOkResponse({ type: StaffEmergencyView })
  async requestCancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelEmergencyDto,
  ): Promise<StaffEmergencyView> {
    return StaffEmergencyView.from(
      await this.sos.requestCancel(id, dto.reasonCode),
      this.ctx.accountId,
    );
  }
}
