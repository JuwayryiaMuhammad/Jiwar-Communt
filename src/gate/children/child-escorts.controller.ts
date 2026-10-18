import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ChildEscortsService } from './child-escorts.service';
import {
  AddChildEscortDto,
  UpdateChildEscortDto,
} from './dto/child-escorts.dto';
import { ChildEscortSecretView, ChildEscortView } from './views/escort.views';

/**
 * Who may collect a child (ADR 0054), the household's side. The household
 * adults read them; the primary or a `household` delegate changes them.
 */
@ApiArea('children')
@RequirePermissions('household.manage')
@Controller('units/:unitId/children/:memberId/control/escorts')
export class ChildEscortsController {
  constructor(private readonly escorts: ChildEscortsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: "List a child's escorts",
    description:
      'For the people who live in the unit: the live escorts, with when and where each may collect the child. Never a pickup code.',
  })
  @ApiOkResponse({ type: ChildEscortView, isArray: true })
  list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
  ): Promise<ChildEscortView[]> {
    return this.escorts.list(unitId, memberId);
  }

  @Post()
  @NoStore()
  @Idempotent({ secret: true })
  @ApiOperation({
    summary: 'Add an escort',
    description:
      'An adult who lives in the unit, one of its domestic workers, or an outside person, who gets a pickup code once: send them the link. Ten live escorts per child at most.',
  })
  @ApiCreatedResponse({ type: ChildEscortSecretView })
  add(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
    @Body() dto: AddChildEscortDto,
  ): Promise<ChildEscortSecretView> {
    return this.escorts.add(unitId, memberId, dto);
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Change when and where an escort may collect the child',
  })
  @ApiOkResponse({ type: ChildEscortView })
  update(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateChildEscortDto,
  ): Promise<ChildEscortView> {
    return this.escorts.update(unitId, memberId, id, dto);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke an escort',
    description:
      'At once: their pickup code and link stop working and an outside photo is deleted.',
  })
  @ApiNoContentResponse()
  async revoke(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
    @Param('id', parseId()) id: string,
  ): Promise<void> {
    await this.escorts.revoke(unitId, memberId, id);
  }

  @Post(':id/reissue')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @Idempotent({ secret: true })
  @ApiOperation({
    summary: "Reissue an outside escort's pickup code",
    description: 'A new code, QR and link, once; the old ones stop at once.',
  })
  @ApiOkResponse({ type: ChildEscortSecretView })
  reissue(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
    @Param('id', parseId()) id: string,
  ): Promise<ChildEscortSecretView> {
    return this.escorts.reissue(unitId, memberId, id);
  }
}
