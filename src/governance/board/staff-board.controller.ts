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
import { CommunityGovernancePort } from '../../community';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BoardService } from './board.service';
import {
  AppointBoardDto,
  BoardSeatDto,
  BoardTermsQueryDto,
  ChangeBoardRoleDto,
  EndBoardSeatDto,
  OwnersQueryDto,
} from './dto/board.dto';
import {
  GovernanceOwnerView,
  StaffBoardNowView,
  StaffBoardTermView,
} from './views/board.views';

const OWNERS_LIMIT = 50;

/** The board register, the manager's side (ADR 0051). */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance')
export class StaffBoardController {
  constructor(
    private readonly board: BoardService,
    private readonly community: CommunityGovernancePort,
    private readonly tenantTx: TenantTx,
  ) {}

  @Get('board')
  @NoStore()
  @ApiOperation({
    summary: 'Get the board’s open term',
    description:
      'Current, or lapsed (past its end with nobody after it); null before the first board. Every seat, ended ones too.',
  })
  @ApiOkResponse({ type: StaffBoardNowView })
  async now(): Promise<StaffBoardNowView> {
    const r = await this.board.staffBoard();
    return { board: r ? StaffBoardTermView.from(r) : null };
  }

  @Get('board/terms')
  @NoStore()
  @ApiOperation({
    summary: 'List the board’s terms',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(StaffBoardTermView) })
  async terms(
    @Query() q: BoardTermsQueryDto,
  ): Promise<ListResponse<StaffBoardTermView>> {
    return toList(await this.board.staffTerms(q), (r) =>
      StaffBoardTermView.from(r),
    );
  }

  @Post('board/appoint')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Appoint a board',
    description:
      'Only when no board sits (BOARD_SITTING): the first one, or after the open term lapsed, which ends now. Its members are told. Later boards come from elections.',
  })
  @ApiCreatedResponse({ type: StaffBoardTermView })
  async appoint(@Body() dto: AppointBoardDto): Promise<StaffBoardTermView> {
    return StaffBoardTermView.from(await this.board.appoint(dto));
  }

  @Post('board/members')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Fill a vacant seat of the sitting board',
    description:
      'No board sits: BOARD_NOT_SITTING; every seat taken: BOARD_SEATS_FULL; the office held: BOARD_OFFICE_TAKEN; seated already: BOARD_ALREADY_SEATED. The member is told.',
  })
  @ApiCreatedResponse({ type: StaffBoardTermView })
  async add(@Body() dto: BoardSeatDto): Promise<StaffBoardTermView> {
    return StaffBoardTermView.from(await this.board.addMember(dto));
  }

  @Patch('board/members/:id')
  @NoStore()
  @ApiOperation({
    summary: 'Give a seated member another role',
    description:
      'The roles the board chose for itself, recorded by the manager. The office held by another: BOARD_OFFICE_TAKEN.',
  })
  @ApiOkResponse({ type: StaffBoardTermView })
  async role(
    @Param('id', parseId()) id: string,
    @Body() dto: ChangeBoardRoleDto,
  ): Promise<StaffBoardTermView> {
    return StaffBoardTermView.from(await this.board.changeRole(id, dto.role));
  }

  @Post('board/members/:id/end')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'End a seat, with a reason code',
    description:
      'From then on the member holds nothing of the board; the seat may be filled again.',
  })
  @ApiOkResponse({ type: StaffBoardTermView })
  async end(
    @Param('id', parseId()) id: string,
    @Body() dto: EndBoardSeatDto,
  ): Promise<StaffBoardTermView> {
    return StaffBoardTermView.from(
      await this.board.endMember(id, dto.reasonCode),
    );
  }

  @Get('owners')
  @NoStore()
  @ApiOperation({
    summary: 'Find owners for the board',
    description: `Active accounts that own a unit now, by name or unit code; at most ${OWNERS_LIMIT}.`,
  })
  @ApiOkResponse({ type: ListOf(GovernanceOwnerView) })
  async owners(
    @Query() q: OwnersQueryDto,
  ): Promise<ListResponse<GovernanceOwnerView>> {
    const owners = await this.tenantTx.withTenantTx((tx) =>
      this.community.ownerDirectory(tx, q.search, OWNERS_LIMIT),
    );
    return bounded(owners, (o) => GovernanceOwnerView.from(o));
  }
}
