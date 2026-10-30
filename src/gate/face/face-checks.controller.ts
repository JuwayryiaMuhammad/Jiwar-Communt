import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { FaceCheckDto } from './dto/face-check.dto';
import { FaceChecksService } from './face-checks.service';
import { FaceCheckView } from './views/face-check.views';

/** A guard's face check against the blocklist's faces (ADR 0068). */
@ApiArea('blocklist')
@RequirePermissions('gate.operate')
@Controller('gate/face-checks')
export class GateFaceChecksController {
  constructor(private readonly checks: FaceChecksService) {}

  @Post()
  @Idempotent()
  @NoStore()
  @ApiOperation({
    summary: 'Check a face against the blocklist’s',
    description:
      'Inside an open shift at a gate, on the guard’s own rate limit, where the compound turned face checks on (else 409 FACE_CHECKS_OFF). Advisory only: the live entries the face may be, never a score. A vendor that does not answer is `unavailable`; an off driver is 503 VENDOR_UNAVAILABLE.',
  })
  @ApiCreatedResponse({ type: FaceCheckView })
  async check(@Body() dto: FaceCheckDto): Promise<FaceCheckView> {
    return FaceCheckView.from(await this.checks.check(dto.photoFileId));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a face check of yours' })
  @ApiOkResponse({ type: FaceCheckView })
  async get(@Param('id', parseId()) id: string): Promise<FaceCheckView> {
    return FaceCheckView.from(await this.checks.get(id));
  }
}
