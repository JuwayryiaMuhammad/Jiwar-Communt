import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  AddPermitWorkerDto,
  CancelPermitDto,
  CreateWorksPermitDto,
  UnitPermitsQueryDto,
} from './dto/permits.dto';
import { PermitWorkersService } from './permit-workers.service';
import { PermitsService } from './permits.service';
import { PermitView } from './views/permit.views';

const UNIT_LIMITS =
  'A unit holds at most 3 live works permits, 2 moves, 5 material exits and 3 upcoming events (PERMIT_LIMIT_REACHED, params.scope and params.max).';

/** A unit's permits, the household's side (ADR 0049). */
@ApiArea('permits')
@RequirePermissions('permits.request')
@Controller()
export class PermitsController {
  constructor(
    private readonly permits: PermitsService,
    private readonly workers: PermitWorkersService,
    private readonly ctx: RequestContext,
  ) {}

  private view = (r: Parameters<typeof PermitView.from>[0]) =>
    PermitView.from(r, this.ctx.accountId);

  @Post('units/:unitId/permits/works')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Ask for a works permit (renovation or finishing)',
    description: `The unit's primary asks (PERMIT_NOT_ALLOWED); the period and the daily hours fit the compound's rules (\`GET /community/permit-rules\`). Pending until the management decides; contractor workers are added one by one. ${UNIT_LIMITS}`,
  })
  @ApiCreatedResponse({ type: PermitView })
  async works(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateWorksPermitDto,
  ): Promise<PermitView> {
    return this.view(await this.permits.createWorks(unitId, dto));
  }

  @Get('units/:unitId/permits')
  @NoStore()
  @ApiOperation({
    summary: 'List a unit’s permits',
    description:
      'Newest first: every permit of the unit for its primary, the caller’s own for anyone else. Workers’ faces are not presigned here: get one permit for them.',
  })
  @ApiOkResponse({ type: ListOf(PermitView) })
  async forUnit(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: UnitPermitsQueryDto,
  ): Promise<ListResponse<PermitView>> {
    return toList(await this.permits.forUnit(unitId, q), this.view);
  }

  @Get('permits/:id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a permit',
    description:
      'The requester’s, or one of the unit the caller is primary of.',
  })
  @ApiOkResponse({ type: PermitView })
  async get(@Param('id', parseId()) id: string): Promise<PermitView> {
    return this.view(await this.permits.get(id));
  }

  @Post('permits/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel a permit',
    description:
      'The requester or the unit’s primary, while it is pending, or approved and not ended (PERMIT_NOT_ACTIVE).',
  })
  @ApiOkResponse({ type: PermitView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelPermitDto,
  ): Promise<PermitView> {
    return this.view(await this.permits.cancel(id, dto.reasonCode));
  }

  @Post('permits/:id/workers')
  @NoStore()
  @Idempotent({ omit: ['idLast4'] })
  @ApiOperation({
    summary: 'Add a contractor worker to a works permit',
    description:
      'While the permit is pending, or approved and not ended (PERMIT_NOT_ACTIVE); at most 30 (PERMIT_LIMIT_REACHED, params.scope `workers`). No new approval. The last four of the ID are kept only as a keyed hash: the guard types them from the card at the gate.',
  })
  @ApiCreatedResponse({ type: PermitView })
  async addWorker(
    @Param('id', parseId()) id: string,
    @Body() dto: AddPermitWorkerDto,
  ): Promise<PermitView> {
    return this.view(await this.workers.add(id, dto));
  }

  @Post('permits/:id/workers/:workerId/remove')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Take a contractor worker off a works permit',
    description: 'From then on the guard refuses them (`worker_removed`).',
  })
  @ApiOkResponse({ type: PermitView })
  async removeWorker(
    @Param('id', parseId()) id: string,
    @Param('workerId', parseId('workerId')) workerId: string,
  ): Promise<PermitView> {
    return this.view(await this.workers.remove(id, workerId));
  }
}
