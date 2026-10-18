import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ChildGateService } from './child-gate.service';
import { ChildCardDto, ChildExitDto } from './dto/child-gate.dto';
import { ChildExitView, ChildVerifyView } from './views/child-gate.views';

/**
 * A child's exit at the gate (ADR 0054), for a guard on shift at a gate or
 * a zone: scan the child's card, then who takes them.
 */
@ApiArea('children')
@RequirePermissions('gate.operate')
@Controller('gate/children')
export class ChildGateController {
  constructor(private readonly gate: ChildGateService) {}

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: "Check a child's card",
    description:
      "The child's first name and photo, whether they may leave alone, and who may collect them today. Writes nothing; one rate limit with `/gate/verify`. Anything that is not a live card of this compound is 404 CHILD_CARD_UNKNOWN.",
  })
  @ApiOkResponse({ type: ChildVerifyView })
  verify(@Body() dto: ChildCardDto): Promise<ChildVerifyView> {
    return this.gate.verify(dto.card);
  }

  @Post('exits')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: "Record a child's exit",
    description:
      "Scan the child's card, then who takes them (a resident's QR, a worker's card or code, a pickup QR or code), or say the child leaves alone, or that the person cannot be identified. Refused: hold the child; the household (and, for a pickup, the security supervisors) are alerted. A credential nobody can be told from is 422 CHILD_ESCORT_UNKNOWN and records nothing. Within five minutes of an exit, the same escort replays it (200) and anyone else is 409 CHILD_JUST_PICKED_UP.",
  })
  @ApiCreatedResponse({ type: ChildExitView })
  @ApiOkResponse({ type: ChildExitView, description: 'A replay of the exit.' })
  async exit(
    @Body() dto: ChildExitDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChildExitView> {
    const e = dto.escort;
    if (
      e.qr === undefined &&
      e.code === undefined &&
      e.alone === undefined &&
      e.unidentified === undefined
    )
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Who takes the child?',
        {
          fields: [{ field: 'escort.qr', code: FieldErrorCode.FIELD_REQUIRED }],
        },
      );
    const { view, replay } = await this.gate.exit({
      card: dto.card,
      escort: e,
    });
    if (replay) res.status(HttpStatus.OK);
    return view;
  }
}
