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
  CancelGovernanceElectionDto,
  CastElectionVoteDto,
  CreateGovernanceElectionDto,
  DisqualifyCandidateDto,
  GovernanceElectionsQueryDto,
  StandForElectionDto,
  UpdateGovernanceElectionDto,
} from './dto/elections.dto';
import { GovernanceElectionsService } from './elections.service';
import {
  GovernanceElectionView,
  GovernanceElectionVoteReceipt,
  StaffGovernanceElectionView,
} from './views/elections.views';

const OWNERS_ONLY =
  'For the units’ owners; anyone else gets GOVERNANCE_NOT_AVAILABLE (404).';
const AUTHORS =
  'A sitting board member or the manager (BOARD_SEAT_REQUIRED, 403).';

/** Elections of the board (ADR 0051): read, stood for, voted, and called by the board. */
@ApiArea('governance')
@Controller('governance/elections')
export class GovernanceElectionsController {
  constructor(private readonly elections: GovernanceElectionsService) {}

  @Get()
  @RequirePermissions('governance.read')
  @NoStore()
  @ApiOperation({
    summary: 'List the board’s elections',
    description: `Newest first. ${OWNERS_ONLY}`,
  })
  @ApiOkResponse({ type: ListOf(GovernanceElectionView) })
  async list(
    @Query() q: GovernanceElectionsQueryDto,
  ): Promise<ListResponse<GovernanceElectionView>> {
    return toList(await this.elections.ownersList(q), (r) =>
      GovernanceElectionView.from(r),
    );
  }

  @Get(':id')
  @RequirePermissions('governance.read')
  @NoStore()
  @ApiOperation({
    summary: 'Get an election',
    description: `Those standing, by name and statement; each one’s votes once voting closed. ${OWNERS_ONLY}`,
  })
  @ApiOkResponse({ type: GovernanceElectionView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<GovernanceElectionView> {
    return GovernanceElectionView.from(await this.elections.ownersGet(id));
  }

  @Post(':id/candidacy')
  @RequirePermissions('governance.read')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Stand for the board',
    description:
      'An owner, while nominations are open (GOVERNANCE_NOMINATIONS_CLOSED), once (GOVERNANCE_ALREADY_CANDIDATE); anyone else: GOVERNANCE_CANDIDACY_NOT_ALLOWED.',
  })
  @ApiCreatedResponse({ type: GovernanceElectionView })
  async stand(
    @Param('id', parseId()) id: string,
    @Body() dto: StandForElectionDto,
  ): Promise<GovernanceElectionView> {
    return GovernanceElectionView.from(
      await this.elections.nominate(id, dto.statement),
    );
  }

  @Post(':id/candidacy/withdraw')
  @RequirePermissions('governance.read')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Withdraw one’s candidacy',
    description: 'While nominations are open (GOVERNANCE_NOMINATIONS_CLOSED).',
  })
  @ApiOkResponse({ type: GovernanceElectionView })
  async withdraw(
    @Param('id', parseId()) id: string,
  ): Promise<GovernanceElectionView> {
    return GovernanceElectionView.from(await this.elections.withdraw(id));
  }

  // The key is remembered without the choice: see `bodyless`.
  @Post(':id/votes')
  @RequirePermissions('governance.read')
  @NoStore()
  @Idempotent({ bodyless: true })
  @ApiOperation({
    summary: 'Cast a unit’s vote',
    description:
      'Up to `seats` candidates, once per unit, never changed (GOVERNANCE_ALREADY_VOTED), by the unit’s voting owner when voting opened (GOVERNANCE_NOT_ELECTOR). Always secret: the answer says the vote was taken and when, never what.',
  })
  @ApiCreatedResponse({ type: GovernanceElectionVoteReceipt })
  vote(
    @Param('id', parseId()) id: string,
    @Body() dto: CastElectionVoteDto,
  ): Promise<GovernanceElectionVoteReceipt> {
    return this.elections.vote(id, dto);
  }

  @Post()
  @RequireAnyPermission('governance.board', 'governance.manage')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Call an election of the board',
    description: `${AUTHORS} Owners are told when nominations open. At most 10 polls and elections under way (GOVERNANCE_LIMIT_REACHED).`,
  })
  @ApiCreatedResponse({ type: GovernanceElectionView })
  async create(
    @Body() dto: CreateGovernanceElectionDto,
  ): Promise<GovernanceElectionView> {
    return GovernanceElectionView.from(await this.elections.create(dto));
  }

  @Patch(':id')
  @RequireAnyPermission('governance.board', 'governance.manage')
  @NoStore()
  @ApiOperation({
    summary: 'Change an election before nominations open',
    description: `${AUTHORS} Its texts, term and dates; never its seats. Once nominations opened: GOVERNANCE_CONTEST_STARTED.`,
  })
  @ApiOkResponse({ type: GovernanceElectionView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateGovernanceElectionDto,
  ): Promise<GovernanceElectionView> {
    return GovernanceElectionView.from(await this.elections.update(id, dto));
  }

  @Post(':id/cancel')
  @RequireAnyPermission('governance.board', 'governance.manage')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Cancel an election, with a reason code',
    description: `${AUTHORS} Until it is certified (GOVERNANCE_CONTEST_ENDED). The board is told.`,
  })
  @ApiOkResponse({ type: GovernanceElectionView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelGovernanceElectionDto,
  ): Promise<GovernanceElectionView> {
    return GovernanceElectionView.from(
      await this.elections.cancel(id, dto.reasonCode),
    );
  }
}

/** Elections of the board, the manager's side (ADR 0051). */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance/elections')
export class StaffGovernanceElectionsController {
  constructor(private readonly elections: GovernanceElectionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the board’s elections',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(StaffGovernanceElectionView) })
  async list(
    @Query() q: GovernanceElectionsQueryDto,
  ): Promise<ListResponse<StaffGovernanceElectionView>> {
    return toList(await this.elections.staffList(q), (r) =>
      StaffGovernanceElectionView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get an election',
    description:
      'Every candidacy, ended ones too; the counts once voting closed.',
  })
  @ApiOkResponse({ type: StaffGovernanceElectionView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffGovernanceElectionView> {
    return StaffGovernanceElectionView.from(await this.elections.staffGet(id));
  }

  @Post(':id/candidates/:candidateId/disqualify')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Take a candidate off the list, with a reason code',
    description:
      'Until voting opens (GOVERNANCE_CONTEST_STARTED): the list is fixed from then on.',
  })
  @ApiOkResponse({ type: StaffGovernanceElectionView })
  async disqualify(
    @Param('id', parseId()) id: string,
    @Param('candidateId', parseId('candidateId')) candidateId: string,
    @Body() dto: DisqualifyCandidateDto,
  ): Promise<StaffGovernanceElectionView> {
    return StaffGovernanceElectionView.from(
      await this.elections.disqualify(id, candidateId, dto.reasonCode),
    );
  }
}
