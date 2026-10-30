import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { StartGateCallDto } from './dto/gate-calls.dto';
import { GateCallsService } from './gate-calls.service';
import {
  AnsweredGateCallView,
  GateCallJoinView,
  GuardGateCallView,
  ResidentGateCallView,
} from './views/gate-call.views';

/** A guard's call from the gate (ADR 0068). */
@ApiArea('gate-calls')
@RequirePermissions('gate.operate')
@Controller('gate/calls')
export class GateCallsController {
  constructor(private readonly calls: GateCallsService) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Call a unit’s household from the gate',
    description:
      'Inside an open shift at a gate. In the app, no number anywhere: the household members a gate request goes to are rung; the first to answer takes it. One live call a guard and a unit (409 GATE_CALL_LIVE). Then join its room (`…/join`).',
  })
  @ApiCreatedResponse({ type: GuardGateCallView })
  async start(@Body() dto: StartGateCallDto): Promise<GuardGateCallView> {
    return GuardGateCallView.from(await this.calls.start(dto));
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a call of yours: whether the household answered',
  })
  @ApiOkResponse({ type: GuardGateCallView })
  async get(@Param('id', parseId()) id: string): Promise<GuardGateCallView> {
    return GuardGateCallView.from(await this.calls.guardGet(id));
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'A token to join your live call’s room' })
  @ApiOkResponse({ type: GateCallJoinView })
  async join(@Param('id', parseId()) id: string): Promise<GateCallJoinView> {
    return GateCallJoinView.from(await this.calls.guardJoin(id));
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End your call' })
  @ApiOkResponse({ type: GuardGateCallView })
  async end(@Param('id', parseId()) id: string): Promise<GuardGateCallView> {
    return GuardGateCallView.from(await this.calls.guardEnd(id));
  }
}

/** A call from the gate, as the household takes it (ADR 0068). */
@ApiArea('gate-calls')
@Controller('me/gate-calls')
export class MyGateCallsController {
  constructor(
    private readonly calls: GateCallsService,
    private readonly ctx: RequestContext,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Get a call from the gate',
    description: 'For whoever in the unit takes gate requests now.',
  })
  @ApiOkResponse({ type: ResidentGateCallView })
  async get(@Param('id', parseId()) id: string): Promise<ResidentGateCallView> {
    return ResidentGateCallView.from(
      await this.calls.residentGet(id),
      this.ctx.accountId,
    );
  }

  @Post(':id/answer')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Answer a call from the gate',
    description:
      'The first answer takes it (another is 409 GATE_CALL_ANSWERED); the one who answered may ask again for a token. The guard learns only that the household answered.',
  })
  @ApiOkResponse({ type: AnsweredGateCallView })
  async answer(
    @Param('id', parseId()) id: string,
  ): Promise<AnsweredGateCallView> {
    const { read, join } = await this.calls.answer(id);
    return {
      call: ResidentGateCallView.from(read, this.ctx.accountId),
      join: GateCallJoinView.from(join),
    };
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a ringing call: it ends for everyone' })
  @ApiOkResponse({ type: ResidentGateCallView })
  async decline(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentGateCallView> {
    return ResidentGateCallView.from(
      await this.calls.decline(id),
      this.ctx.accountId,
    );
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the call you answered' })
  @ApiOkResponse({ type: ResidentGateCallView })
  async end(@Param('id', parseId()) id: string): Promise<ResidentGateCallView> {
    return ResidentGateCallView.from(
      await this.calls.residentEnd(id),
      this.ctx.accountId,
    );
  }
}

/**
 * The call vendor's events (ADR 0068), per compound: as the guard-down
 * vendor's (200, 401 the same whatever, 404 off, 500 call again).
 */
@ApiArea('public', 'public')
@Public()
@Controller('public/gate/calls')
export class GateCallsWebhookController {
  constructor(private readonly calls: GateCallsService) {}

  @Post(':compoundId/events')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(
    @Param('compoundId') compoundId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: boolean }> {
    const answer = await this.calls.receive(compoundId, headers, body, ip);
    res.status(answer.status);
    return { ok: answer.status === 200 };
  }
}
