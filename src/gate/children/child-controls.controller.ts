import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import { ChildControlsService } from './child-controls.service';
import {
  ChildPhotoDto,
  TurnOnChildControlDto,
  UpdateChildControlDto,
} from './dto/child-controls.dto';
import {
  ChildControlSecretView,
  ChildControlView,
  ChildView,
} from './views/child.views';

/**
 * A child's exit control (ADR 0054), the household's side. The household
 * adults read it; the primary or a `household` delegate changes it.
 */
@ApiArea('children')
@RequirePermissions('household.manage')
@Controller('units/:unitId/children')
export class ChildControlsController {
  constructor(private readonly controls: ChildControlsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: "List the unit's children and their exit control",
    description:
      'For the people who live in the unit. Each minor under 18, with their control when it is on (never the card).',
  })
  @ApiOkResponse({ type: ChildView, isArray: true })
  list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ChildView[]> {
    return this.controls.list(unitId);
  }

  @Post(':memberId/control')
  @NoStore()
  @Idempotent({ secret: true })
  @ApiOperation({
    summary: "Turn on a child's exit control",
    description:
      "The unit's primary or a household delegate. Answers the child's card once: print it. A retry with the same `Idempotency-Key` prints a new one.",
  })
  @ApiCreatedResponse({ type: ChildControlSecretView })
  turnOn(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
    @Body() dto: TurnOnChildControlDto,
  ): Promise<ChildControlSecretView> {
    return this.controls.turnOn(unitId, memberId, dto);
  }

  @Patch(':memberId/control')
  @NoStore()
  @ApiOperation({ summary: "Change a child's exit control" })
  @ApiOkResponse({ type: ChildControlView })
  update(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
    @Body() dto: UpdateChildControlDto,
  ): Promise<ChildControlView> {
    return this.controls.update(unitId, memberId, dto);
  }

  @Post(':memberId/control/off')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Turn off a child's exit control",
    description:
      'At once: the card stops scanning, the photo is deleted and every escort is revoked.',
  })
  @ApiNoContentResponse()
  async turnOff(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
  ): Promise<void> {
    await this.controls.turnOff(unitId, memberId);
  }

  @Post(':memberId/control/card')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @Idempotent({ secret: true })
  @ApiOperation({
    summary: "Reissue a child's card",
    description:
      'A lost card: a new one, once. The old card stops scanning at once.',
  })
  @ApiOkResponse({ type: ChildControlSecretView })
  reissueCard(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
  ): Promise<ChildControlSecretView> {
    return this.controls.reissueCard(unitId, memberId);
  }

  @Put(':memberId/control/photo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Set or replace a child's photo",
    description:
      'Shown to the household and to a guard checking the child at the gate; deleted when the control ends.',
  })
  @ApiNoContentResponse()
  async setPhoto(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
    @Body() dto: ChildPhotoDto,
  ): Promise<void> {
    await this.controls.setPhoto(unitId, memberId, dto.fileId);
  }

  @Delete(':memberId/control/photo')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a child's photo" })
  @ApiNoContentResponse()
  async removePhoto(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('memberId', parseId('memberId')) memberId: string,
  ): Promise<void> {
    await this.controls.removePhoto(unitId, memberId);
  }
}
