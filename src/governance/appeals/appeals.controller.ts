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
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { PageQueryDto } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { MotionsService } from '../motions/motions.service';
import { BoardMotionView } from '../motions/views/motions.views';
import { BoardAppealsService } from './appeals.service';
import {
  BoardAppealsQueryDto,
  LodgeBoardAppealDto,
  ProposeAppealMotionDto,
} from './dto/appeals.dto';
import {
  BoardAppealBoardView,
  BoardAppealView,
  StaffBoardAppealView,
} from './views/appeals.views';

/** Appeals to the board, the owners' side (ADR 0055). */
@ApiArea('governance')
@RequirePermissions('governance.read')
@Controller('governance/board-appeals')
export class BoardAppealsController {
  constructor(private readonly appeals: BoardAppealsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Appeal a staff decision to the board',
    description:
      'An owner of the decision’s unit, or its primary (BOARD_APPEAL_NOT_ALLOWED), within 15 days of the staff’s decision (BOARD_APPEAL_WINDOW_PASSED), once per decision (BOARD_APPEAL_EXISTS); BOARD_APPEAL_NOT_ELIGIBLE when it no longer stands against the unit. A fine or a violation waits for the board: no payment until it decides.',
  })
  @ApiCreatedResponse({ type: BoardAppealView })
  async lodge(@Body() dto: LodgeBoardAppealDto): Promise<BoardAppealView> {
    return BoardAppealView.from(await this.appeals.lodge(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The board appeals of the caller’s units',
    description: 'And the caller’s own; newest first.',
  })
  @ApiOkResponse({ type: ListOf(BoardAppealView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<BoardAppealView>> {
    return toList(await this.appeals.ownersList(q), (r) =>
      BoardAppealView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read a board appeal' })
  @ApiOkResponse({ type: BoardAppealView })
  async get(@Param('id', parseId()) id: string): Promise<BoardAppealView> {
    return BoardAppealView.from(await this.appeals.ownersGet(id));
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Withdraw a pending board appeal',
    description: 'The appellant only (BOARD_APPEAL_NOT_YOURS).',
  })
  @ApiOkResponse({ type: BoardAppealView })
  async withdraw(@Param('id', parseId()) id: string): Promise<BoardAppealView> {
    return BoardAppealView.from(await this.appeals.withdraw(id));
  }
}

/** Appeals to the board, the management's side (ADR 0055): a party. */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance/board-appeals')
export class StaffBoardAppealsController {
  constructor(private readonly appeals: BoardAppealsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The appeals to the board',
    description:
      'Newest first: where each stands, the decision and its reasons, the follow-up. Never the grounds or the board’s deliberation.',
  })
  @ApiOkResponse({ type: ListOf(StaffBoardAppealView) })
  async list(
    @Query() q: BoardAppealsQueryDto,
  ): Promise<ListResponse<StaffBoardAppealView>> {
    return toList(await this.appeals.staffList(q), (r) =>
      StaffBoardAppealView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read an appeal to the board' })
  @ApiOkResponse({ type: StaffBoardAppealView })
  async get(@Param('id', parseId()) id: string): Promise<StaffBoardAppealView> {
    return StaffBoardAppealView.from(await this.appeals.staffGet(id));
  }

  @Post(':id/followed-up')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Mark an overturn followed up',
    description:
      'An overturn its domain left to the management (a dispute: credit the invoice), once (BOARD_APPEAL_NO_FOLLOW_UP).',
  })
  @ApiOkResponse({ type: StaffBoardAppealView })
  async followedUp(
    @Param('id', parseId()) id: string,
  ): Promise<StaffBoardAppealView> {
    return StaffBoardAppealView.from(await this.appeals.followedUp(id));
  }
}

/** Appeals to the board, the board's side (ADR 0055). */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/appeals')
export class BoardAppealsBoardController {
  constructor(
    private readonly appeals: BoardAppealsService,
    private readonly motions: MotionsService,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The appeals to the board',
    description: 'What awaits the board (`status=pending`) and the rest.',
  })
  @ApiOkResponse({ type: ListOf(StaffBoardAppealView) })
  async list(
    @Query() q: BoardAppealsQueryDto,
  ): Promise<ListResponse<StaffBoardAppealView>> {
    return toList(await this.appeals.boardList(q), (r) =>
      StaffBoardAppealView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary:
      'Read an appeal with its grounds, its subject and the board’s motions',
  })
  @ApiOkResponse({ type: BoardAppealBoardView })
  async get(@Param('id', parseId()) id: string): Promise<BoardAppealBoardView> {
    return BoardAppealBoardView.fromBoard(await this.appeals.boardGet(id));
  }

  @Post(':id/motions')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Propose a motion on an appeal',
    description:
      'Uphold or overturn, with the reasons. A member living in or owning the unit, or who appealed, is recused (BOARD_MEMBER_RECUSED); too few left for the quorum: BOARD_QUORUM_UNAVAILABLE.',
  })
  @ApiCreatedResponse({ type: BoardMotionView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: ProposeAppealMotionDto,
  ): Promise<BoardMotionView> {
    return BoardMotionView.from(await this.motions.propose('appeal', id, dto));
  }
}
