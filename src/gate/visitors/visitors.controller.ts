import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { parseIdempotencyKey } from '../../core/idempotency/idempotency-key';
import { IdempotencyHeader } from '../../core/idempotency/idempotent.decorator';
import {
  CancelVisitorPassDto,
  CreateVisitorPassDto,
  GateInstructionsDto,
} from './dto/visitors.dto';
import { InstructionsService } from './instructions.service';
import { VisitorPassesService } from './visitor-passes.service';
import {
  GateInstructionsView,
  IssuedPassView,
  PassView,
} from './views/visitor.views';

/** Visitor passes and a household's gate instructions (ADR 0028). */
@ApiArea('visitors')
@Controller()
export class VisitorsController {
  constructor(
    private readonly passes: VisitorPassesService,
    private readonly instructions: InstructionsService,
  ) {}

  /** The code is shown once. A retry with the same key gets a fresh code. */
  @RequirePermissions('visitors.invite')
  @Post('units/:unitId/visitor-passes')
  @NoStore()
  @IdempotencyHeader()
  @ApiCreatedResponse({ type: IssuedPassView })
  async create(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateVisitorPassDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<IssuedPassView> {
    return IssuedPassView.from(
      await this.passes.create(unitId, dto, parseIdempotencyKey(key)),
    );
  }

  @RequirePermissions('visitors.invite')
  @Get('units/:unitId/visitor-passes')
  @ApiOkResponse({ type: ListOf(PassView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PassView>> {
    return toList(await this.passes.listForUnit(unitId, q), (p) =>
      PassView.from(p),
    );
  }

  @RequirePermissions('visitors.invite')
  @Post('visitor-passes/:id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelVisitorPassDto,
  ): Promise<void> {
    await this.passes.cancel(id, dto.reasonCode);
  }

  @RequirePermissions('household.manage')
  @Get('units/:unitId/gate-instructions')
  @ApiOkResponse({ type: GateInstructionsView })
  async getInstructions(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<GateInstructionsView> {
    return GateInstructionsView.from(await this.instructions.get(unitId));
  }

  @RequirePermissions('household.manage')
  @Put('units/:unitId/gate-instructions')
  @ApiOkResponse({ type: GateInstructionsView })
  async setInstructions(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: GateInstructionsDto,
  ): Promise<GateInstructionsView> {
    return GateInstructionsView.from(await this.instructions.set(unitId, dto));
  }
}
