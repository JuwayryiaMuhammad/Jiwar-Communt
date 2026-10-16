import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { BoardService } from './board.service';
import { BoardTermsQueryDto } from './dto/board.dto';
import { BoardNowView, BoardTermView } from './views/board.views';

const OWNERS_ONLY =
  'For the units’ owners; anyone else gets GOVERNANCE_NOT_AVAILABLE (404).';

/** The owners' board, as the owners see it (ADR 0051). */
@ApiArea('governance')
@RequirePermissions('governance.read')
@Controller('governance/board')
export class GovernanceBoardController {
  constructor(private readonly board: BoardService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Get the board sitting now',
    description: `Its term and its seated members by name and role; \`board\` is null when none sits. ${OWNERS_ONLY}`,
  })
  @ApiOkResponse({ type: BoardNowView })
  async now(): Promise<BoardNowView> {
    const r = await this.board.ownersBoard();
    return { board: r ? BoardTermView.from(r) : null };
  }

  @Get('terms')
  @NoStore()
  @ApiOperation({
    summary: 'List the board’s terms',
    description: `Newest first, each with everyone who sat in it. ${OWNERS_ONLY}`,
  })
  @ApiOkResponse({ type: ListOf(BoardTermView) })
  async terms(
    @Query() q: BoardTermsQueryDto,
  ): Promise<ListResponse<BoardTermView>> {
    return toList(await this.board.ownersTerms(q), (r) =>
      BoardTermView.from(r),
    );
  }
}
