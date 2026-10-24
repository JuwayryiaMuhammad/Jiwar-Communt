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
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  AgendaQueryDto,
  DecideAgendaDto,
  ProposeAgendaDto,
} from './agenda.dto';
import { AgendaService } from './agenda.service';
import { AgendaProposalView } from './agenda.views';

/** Agenda proposals, the owners' side (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('governance.read')
@Controller('governance/agenda-proposals')
export class AgendaProposalsController {
  constructor(private readonly agenda: AgendaService) {}

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Propose a matter for the board’s agenda',
    description:
      'An owner (GOVERNANCE_NOT_AVAILABLE otherwise), at most three open at once (AGENDA_PROPOSAL_LIMIT). The board accepts or declines it; accepting binds nothing.',
  })
  @ApiCreatedResponse({ type: AgendaProposalView })
  async propose(@Body() dto: ProposeAgendaDto): Promise<AgendaProposalView> {
    return AgendaProposalView.from(await this.agenda.propose(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'The caller’s agenda proposals, newest first' })
  @ApiOkResponse({ type: ListOf(AgendaProposalView) })
  async list(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<AgendaProposalView>> {
    return toList(await this.agenda.mine(q), (p) => AgendaProposalView.from(p));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read one of the caller’s agenda proposals' })
  @ApiOkResponse({ type: AgendaProposalView })
  async get(@Param('id', parseId()) id: string): Promise<AgendaProposalView> {
    return AgendaProposalView.from(await this.agenda.getMine(id));
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Withdraw an open agenda proposal',
    description: 'Its proposer, while open (AGENDA_PROPOSAL_NOT_OPEN).',
  })
  @ApiOkResponse({ type: AgendaProposalView })
  async withdraw(
    @Param('id', parseId()) id: string,
  ): Promise<AgendaProposalView> {
    return AgendaProposalView.from(await this.agenda.withdraw(id));
  }
}

/** Agenda proposals, the board's side (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/agenda-proposals')
export class BoardAgendaController {
  constructor(private readonly agenda: AgendaService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The owners’ agenda proposals',
    description: 'What awaits the board (`status=open`) and the rest.',
  })
  @ApiOkResponse({ type: ListOf(AgendaProposalView) })
  async list(
    @Query() q: AgendaQueryDto,
  ): Promise<ListResponse<AgendaProposalView>> {
    return toList(await this.agenda.boardList(q), (p) =>
      AgendaProposalView.from(p),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read an agenda proposal' })
  @ApiOkResponse({ type: AgendaProposalView })
  async get(@Param('id', parseId()) id: string): Promise<AgendaProposalView> {
    return AgendaProposalView.from(await this.agenda.boardGet(id));
  }

  @Post(':id/decide')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Accept or decline an agenda proposal',
    description:
      'A sitting member (BOARD_SEAT_REQUIRED), once (AGENDA_PROPOSAL_NOT_OPEN); a decline with its code. The proposer is told.',
  })
  @ApiOkResponse({ type: AgendaProposalView })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideAgendaDto,
  ): Promise<AgendaProposalView> {
    return AgendaProposalView.from(await this.agenda.decide(id, dto));
  }
}
