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
import { GuardSosService } from './guard-sos.service';
import { StaffEmergencyView } from './views/staff-emergency.views';

/** A guard's SOS from their post (ADR 0053), inside an open shift. */
@ApiArea('emergencies')
@RequirePermissions('gate.operate')
@Controller('gate/emergencies')
export class GuardSosController {
  constructor(
    private readonly sos: GuardSosService,
    private readonly ctx: RequestContext,
  ) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Raise an SOS from your post',
    description:
      'From the gate or the zone of your open shift (NO_OPEN_SHIFT without one). The other guards on shift, the responders and the management are told at once (a critical push); nobody’s family is. One open per post and type: a repeat answers 200 with the open one.',
  })
  @ApiCreatedResponse({ type: StaffEmergencyView })
  @ApiOkResponse({ type: StaffEmergencyView, description: 'The open one.' })
  async raise(
    @Body() dto: RaiseSosDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffEmergencyView> {
    const { record, created } = await this.sos.raise(dto.type);
    if (!created) res.status(HttpStatus.OK);
    return StaffEmergencyView.from(record, this.ctx.accountId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel the SOS you raised',
    description:
      'While it is open, with a code from `emergencyCancel` or none. Another’s SOS is not found.',
  })
  @ApiOkResponse({ type: StaffEmergencyView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelEmergencyDto,
  ): Promise<StaffEmergencyView> {
    return StaffEmergencyView.from(
      await this.sos.cancel(id, dto.reasonCode),
      this.ctx.accountId,
    );
  }
}
