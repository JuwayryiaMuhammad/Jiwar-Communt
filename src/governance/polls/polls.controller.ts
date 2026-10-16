import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CancelGovernancePollDto,
  CastPollVoteDto,
  CreateGovernancePollDto,
  GovernancePollsQueryDto,
  UpdateGovernancePollDto,
} from './dto/polls.dto';
import { GovernancePollsService } from './polls.service';
import {
  GovernancePollView,
  GovernanceVoteReceipt,
  StaffGovernancePollView,
} from './views/polls.views';

const OWNERS_ONLY =
  'For the units’ owners; anyone else gets GOVERNANCE_NOT_AVAILABLE (404).';
const AUTHORS =
  'A sitting board member or the manager (BOARD_SEAT_REQUIRED, 403).';

/** The owners' polls (ADR 0051): read, voted, and put by the board. */
@ApiArea('governance')
@Controller('governance/polls')
export class GovernancePollsController {
  constructor(private readonly polls: GovernancePollsService) {}

  @Get()
  @RequirePermissions('governance.read')
  @NoStore()
  @ApiOperation({
    summary: 'List the owners’ polls',
    description: `Newest first, each with the caller’s units in it. No counts while voting is open, only the turnout. ${OWNERS_ONLY}`,
  })
  @ApiOkResponse({ type: ListOf(GovernancePollView) })
  async list(
    @Query() q: GovernancePollsQueryDto,
  ): Promise<ListResponse<GovernancePollView>> {
    return toList(await this.polls.ownersList(q), (r) =>
      GovernancePollView.from(r),
    );
  }

  @Get(':id')
  @RequirePermissions('governance.read')
  @NoStore()
  @ApiOperation({
    summary: 'Get a poll',
    description: `The counts and the result once it closed; an open vote’s roll call too. ${OWNERS_ONLY} An elector who sold the unit since it opened still reads it.`,
  })
  @ApiOkResponse({ type: GovernancePollView })
  async get(@Param('id', parseId()) id: string): Promise<GovernancePollView> {
    return GovernancePollView.from(await this.polls.ownersGet(id));
  }

  // The key is remembered without the choice: see `bodyless`.
  @Post(':id/votes')
  @RequirePermissions('governance.read')
  @NoStore()
  @Idempotent({ bodyless: true })
  @ApiOperation({
    summary: 'Cast a unit’s vote',
    description:
      'Once per unit, never changed (GOVERNANCE_ALREADY_VOTED), by the unit’s voting owner when the poll opened (GOVERNANCE_NOT_ELECTOR), while it is open (GOVERNANCE_CONTEST_NOT_OPEN). The answer says the vote was taken and when, never what; a retry with the same key replays it.',
  })
  @ApiCreatedResponse({ type: GovernanceVoteReceipt })
  vote(
    @Param('id', parseId()) id: string,
    @Body() dto: CastPollVoteDto,
  ): Promise<GovernanceVoteReceipt> {
    return this.polls.vote(id, dto);
  }

  @Post()
  @RequireAnyPermission('governance.board', 'governance.manage')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Put a poll to the owners',
    description: `${AUTHORS} Opens at \`opensAt\` (now when absent): its electorate is each unit’s voting owner then. At most 10 polls and elections under way (GOVERNANCE_LIMIT_REACHED).`,
  })
  @ApiCreatedResponse({ type: GovernancePollView })
  async create(
    @Body() dto: CreateGovernancePollDto,
  ): Promise<GovernancePollView> {
    return GovernancePollView.from(await this.polls.create(dto));
  }

  @Patch(':id')
  @RequireAnyPermission('governance.board', 'governance.manage')
  @NoStore()
  @ApiOperation({
    summary: 'Change a poll before voting opens',
    description: `${AUTHORS} Anything but its secrecy; once open, GOVERNANCE_CONTEST_STARTED.`,
  })
  @ApiOkResponse({ type: GovernancePollView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateGovernancePollDto,
  ): Promise<GovernancePollView> {
    return GovernancePollView.from(await this.polls.update(id, dto));
  }

  @Post(':id/cancel')
  @RequireAnyPermission('governance.board', 'governance.manage')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel a poll, with a reason code',
    description: `${AUTHORS} Before it closes (GOVERNANCE_CONTEST_ENDED); nothing is counted, and a secret poll’s ballots are destroyed unread.`,
  })
  @ApiOkResponse({ type: GovernancePollView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelGovernancePollDto,
  ): Promise<GovernancePollView> {
    return GovernancePollView.from(await this.polls.cancel(id, dto.reasonCode));
  }
}

/** The owners' polls, the manager's side (ADR 0051). */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance/polls')
export class StaffGovernancePollsController {
  constructor(private readonly polls: GovernancePollsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the owners’ polls',
    description: 'Newest first. No counts while voting is open.',
  })
  @ApiOkResponse({ type: ListOf(StaffGovernancePollView) })
  async list(
    @Query() q: GovernancePollsQueryDto,
  ): Promise<ListResponse<StaffGovernancePollView>> {
    return toList(await this.polls.staffList(q), (r) =>
      StaffGovernancePollView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a poll, with its results once closed' })
  @ApiOkResponse({ type: StaffGovernancePollView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffGovernancePollView> {
    return StaffGovernancePollView.from(await this.polls.staffGet(id));
  }
}
