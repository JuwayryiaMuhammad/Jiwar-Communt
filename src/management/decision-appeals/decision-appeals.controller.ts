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
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { DecisionAppealsService } from './decision-appeals.service';
import {
  DecideDecisionAppealDto,
  DecisionAppealsQueryDto,
  LodgeDecisionAppealDto,
} from './dto/decision-appeals.dto';
import {
  DecisionAppealView,
  StaffDecisionAppealView,
} from './views/decision-appeal.views';

/** Decision appeals, the residents' side (ADR 0059). */
@ApiArea('management')
@RequirePermissions('units.read')
@Controller('decision-appeals')
export class DecisionAppealsController {
  constructor(private readonly appeals: DecisionAppealsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Appeal a staff decision about the caller’s unit',
    description:
      'A rejected permit (its unit’s primary), a rejected vehicle (its keepers or the primary), a rejected worker (the household that employs them), a neighbour notice (its recipients): DECISION_APPEAL_NOT_ALLOWED otherwise. Within 15 days of the decision (DECISION_APPEAL_WINDOW_PASSED), once per decision (DECISION_APPEAL_EXISTS); DECISION_APPEAL_NOT_ELIGIBLE when it no longer stands. A manager who did not take the decision decides it.',
  })
  @ApiCreatedResponse({ type: DecisionAppealView })
  async lodge(
    @Body() dto: LodgeDecisionAppealDto,
  ): Promise<DecisionAppealView> {
    return DecisionAppealView.from(await this.appeals.lodge(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The caller’s decision appeals',
    description:
      'Their own, and those of the units they are the primary of (without the grounds); newest first.',
  })
  @ApiOkResponse({ type: ListOf(DecisionAppealView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<DecisionAppealView>> {
    return toList(await this.appeals.residentList(q), (r) =>
      DecisionAppealView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read a decision appeal' })
  @ApiOkResponse({ type: DecisionAppealView })
  async get(@Param('id', parseId()) id: string): Promise<DecisionAppealView> {
    return DecisionAppealView.from(await this.appeals.residentGet(id));
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Withdraw a pending decision appeal',
    description: 'The appellant only (DECISION_APPEAL_NOT_YOURS).',
  })
  @ApiOkResponse({ type: DecisionAppealView })
  async withdraw(
    @Param('id', parseId()) id: string,
  ): Promise<DecisionAppealView> {
    return DecisionAppealView.from(await this.appeals.withdraw(id));
  }
}

/** Decision appeals, the deciders' side (ADR 0059). */
@ApiArea('management')
@RequirePermissions('appeals.decide')
@Controller('staff/decision-appeals')
export class StaffDecisionAppealsController {
  constructor(
    private readonly appeals: DecisionAppealsService,
    private readonly ctx: RequestContext,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The decision appeals',
    description:
      'What awaits a decision (`status=pending`) and the rest, newest first, with the grounds.',
  })
  @ApiOkResponse({ type: ListOf(StaffDecisionAppealView) })
  async list(
    @Query() q: DecisionAppealsQueryDto,
  ): Promise<ListResponse<StaffDecisionAppealView>> {
    return toList(await this.appeals.staffList(q), (r) =>
      StaffDecisionAppealView.from(r, this.ctx.accountId),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read a decision appeal with its attachments' })
  @ApiOkResponse({ type: StaffDecisionAppealView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffDecisionAppealView> {
    return StaffDecisionAppealView.from(
      await this.appeals.staffGet(id),
      this.ctx.accountId,
    );
  }

  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Uphold or overturn a decision appeal',
    description:
      'Once (DECISION_APPEAL_NOT_PENDING), never by the one who took the decision (APPEAL_DECIDER_CONFLICT), with the reasons. An overturn runs the decision’s normal approval with all its checks: a permit approved (its window, its requester, the unit’s limit, the work days and hours, the blocklist), a vehicle activated (with the sticker and permit date given here, its plate and the unit’s limit), a notice withdrawn; a worker is always left to follow up. A check that refuses leaves it to follow up, with the reason.',
  })
  @ApiOkResponse({ type: StaffDecisionAppealView })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideDecisionAppealDto,
  ): Promise<StaffDecisionAppealView> {
    return StaffDecisionAppealView.from(
      await this.appeals.decide(id, dto),
      this.ctx.accountId,
    );
  }

  @Post(':id/followed-up')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Mark an overturn followed up',
    description:
      'An overturn its domain left to the management (a worker’s review, a check that refused), once (DECISION_APPEAL_NO_FOLLOW_UP).',
  })
  @ApiOkResponse({ type: StaffDecisionAppealView })
  async followedUp(
    @Param('id', parseId()) id: string,
  ): Promise<StaffDecisionAppealView> {
    return StaffDecisionAppealView.from(
      await this.appeals.followedUp(id),
      this.ctx.accountId,
    );
  }
}
