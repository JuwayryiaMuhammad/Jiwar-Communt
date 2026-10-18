import {
  Body,
  Controller,
  Get,
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
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { LockdownOverrideDto, StartLockdownDto } from './dto/lockdown.dto';
import { LockdownService } from './lockdown.service';
import {
  GuardLockdownView,
  LockdownOverrideView,
} from './views/lockdown.views';

/** The lockdown, the guard's side (ADR 0053): `gate.operate`, on shift. */
@ApiArea('lockdown')
@RequirePermissions('gate.operate')
@Controller('gate/lockdowns')
export class GateLockdownsController {
  constructor(private readonly lockdowns: LockdownService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Lock one gate or all down',
    description:
      'A guard on shift (at a gate or in a zone), with a reason code and the typed confirmation `LOCKDOWN`. Immediate. While it is live every entry in but a resident’s is refused (LOCKDOWN_ACTIVE). The guards on shift and the management get a critical push, every resident a generic one. One live per scope: a repeat answers 200 with it.',
  })
  @ApiCreatedResponse({ type: GuardLockdownView })
  @ApiOkResponse({ type: GuardLockdownView, description: 'The live one.' })
  async start(
    @Body() dto: StartLockdownDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GuardLockdownView> {
    const { record, created } = await this.lockdowns.start(dto);
    if (!created) res.status(HttpStatus.OK);
    return GuardLockdownView.from(record);
  }

  @Get('active')
  @NoStore()
  @ApiOperation({
    summary: 'The live lockdowns',
    description: 'Each gate’s own, and the one of every gate.',
  })
  @ApiOkResponse({ type: [GuardLockdownView] })
  async active(): Promise<GuardLockdownView[]> {
    return (await this.lockdowns.live()).map((r) => GuardLockdownView.from(r));
  }

  @Post(':id/overrides')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Let an emergency vehicle through a locked gate',
    description:
      'At the gate of your shift, which the lockdown must hold (LOCKDOWN_NOT_AT_GATE), with what came through. Recorded and audited.',
  })
  @ApiCreatedResponse({ type: LockdownOverrideView })
  async override(
    @Param('id', parseId()) id: string,
    @Body() dto: LockdownOverrideDto,
  ): Promise<LockdownOverrideView> {
    return LockdownOverrideView.from(await this.lockdowns.override(id, dto));
  }
}
