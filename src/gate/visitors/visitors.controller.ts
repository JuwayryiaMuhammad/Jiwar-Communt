import {
  Body,
  Controller,
  Get,
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
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import {
  ApiArea,
  NoStore,
  RequestHeader,
} from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  IDEMPOTENCY_HEADER,
  parseIdempotencyKey,
} from '../../core/idempotency/idempotency-key';
import {
  Idempotent,
  IdempotencyHeader,
} from '../../core/idempotency/idempotent.decorator';
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
  PassDetailView,
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

  /** A retry with the same key gets a fresh code; the first one dies. */
  @RequirePermissions('visitors.invite')
  @Post('units/:unitId/visitor-passes')
  @ApiOperation({ summary: 'Create a visitor pass' })
  @NoStore()
  @IdempotencyHeader()
  @ApiCreatedResponse({ type: IssuedPassView })
  async create(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateVisitorPassDto,
    @RequestHeader(IDEMPOTENCY_HEADER) key?: string,
  ): Promise<IssuedPassView> {
    return IssuedPassView.from(
      await this.passes.create(unitId, dto, parseIdempotencyKey(key)),
    );
  }

  @RequirePermissions('visitors.invite')
  @Get('units/:unitId/visitor-passes')
  @ApiOperation({ summary: "List the unit's visitor passes" })
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
  @Get('visitor-passes/:id')
  @ApiOperation({ summary: 'Get a visitor pass' })
  @NoStore()
  @ApiOkResponse({ type: PassDetailView })
  async get(@Param('id', parseId()) id: string): Promise<PassDetailView> {
    return PassDetailView.fromDetail(await this.passes.getOne(id));
  }

  /**
   * The host lost the link (ADR 0030): a new link, QR and code for the same
   * pass, the old ones dead at once. A retry with the same key reissues
   * again — the secret is never stored to be replayed.
   */
  @RequirePermissions('visitors.invite')
  @Post('visitor-passes/:id/reissue-link')
  @ApiOperation({ summary: "Reissue a visitor pass's link, QR and code" })
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @Idempotent({ secret: true })
  @ApiOkResponse({ type: IssuedPassView })
  async reissueLink(
    @Param('id', parseId()) id: string,
  ): Promise<IssuedPassView> {
    return IssuedPassView.from(await this.passes.reissueLink(id));
  }

  @RequirePermissions('visitors.invite')
  @Post('visitor-passes/:id/cancel')
  @ApiOperation({ summary: 'Cancel a visitor pass' })
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
  @ApiOperation({ summary: "Get the household's gate instructions" })
  @ApiOkResponse({ type: GateInstructionsView })
  async getInstructions(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<GateInstructionsView> {
    return GateInstructionsView.from(await this.instructions.get(unitId));
  }

  @RequirePermissions('household.manage')
  @Put('units/:unitId/gate-instructions')
  @ApiOperation({ summary: "Set the household's gate instructions" })
  @ApiOkResponse({ type: GateInstructionsView })
  async setInstructions(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: GateInstructionsDto,
  ): Promise<GateInstructionsView> {
    return GateInstructionsView.from(await this.instructions.set(unitId, dto));
  }
}
