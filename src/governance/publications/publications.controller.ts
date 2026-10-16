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
  BoardPublicationsQueryDto,
  BoardPublicationTextDto,
  PublishBoardPublicationDto,
} from './dto/publications.dto';
import { BoardPublicationsService } from './publications.service';
import { BoardPublicationView } from './views/publications.views';

const AUTHORS =
  'A sitting board member or the manager (BOARD_SEAT_REQUIRED, 403).';

/** The board's decisions and minutes (ADR 0051). */
@ApiArea('governance')
@Controller('governance/publications')
export class BoardPublicationsController {
  constructor(private readonly publications: BoardPublicationsService) {}

  @Get()
  @RequirePermissions('governance.read')
  @NoStore()
  @ApiOperation({
    summary: 'List the board’s decisions and minutes',
    description:
      'Newest first, archived ones left out. For the units’ owners (GOVERNANCE_NOT_AVAILABLE otherwise); each is also an announcement in their feed.',
  })
  @ApiOkResponse({ type: ListOf(BoardPublicationView) })
  async list(
    @Query() q: BoardPublicationsQueryDto,
  ): Promise<ListResponse<BoardPublicationView>> {
    return toList(await this.publications.ownersList(q), (r) =>
      BoardPublicationView.from(r),
    );
  }

  @Post()
  @RequireAnyPermission('governance.board', 'governance.manage')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Publish a decision or the minutes of the board',
    description: `${AUTHORS} While a board sits (BOARD_NOT_SITTING). An announcement of kind \`board\` to the owners, out now, nobody pushed, with an optional PDF.`,
  })
  @ApiCreatedResponse({ type: BoardPublicationView })
  async publish(
    @Body() dto: PublishBoardPublicationDto,
  ): Promise<BoardPublicationView> {
    return BoardPublicationView.from(await this.publications.publish(dto));
  }

  @Patch(':id')
  @RequireAnyPermission('governance.board', 'governance.manage')
  @NoStore()
  @ApiOperation({
    summary: 'Correct a decision’s or the minutes’ words',
    description: `${AUTHORS} A new version of its announcement, shown as edited; the PDF stays.`,
  })
  @ApiOkResponse({ type: BoardPublicationView })
  async edit(
    @Param('id', parseId()) id: string,
    @Body() dto: BoardPublicationTextDto,
  ): Promise<BoardPublicationView> {
    return BoardPublicationView.from(await this.publications.edit(id, dto));
  }

  @Post(':id/archive')
  @RequireAnyPermission('governance.board', 'governance.manage')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Archive a decision or the minutes',
    description: `${AUTHORS} Its announcement comes down for good.`,
  })
  @ApiOkResponse({ type: BoardPublicationView })
  async archive(
    @Param('id', parseId()) id: string,
  ): Promise<BoardPublicationView> {
    return BoardPublicationView.from(await this.publications.archive(id));
  }
}

/** The board's decisions and minutes, the manager's side (ADR 0051). */
@ApiArea('governance')
@RequirePermissions('governance.manage')
@Controller('staff/governance/publications')
export class StaffBoardPublicationsController {
  constructor(private readonly publications: BoardPublicationsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the board’s decisions and minutes',
    description: 'Newest first, archived ones too.',
  })
  @ApiOkResponse({ type: ListOf(BoardPublicationView) })
  async list(
    @Query() q: BoardPublicationsQueryDto,
  ): Promise<ListResponse<BoardPublicationView>> {
    return toList(await this.publications.staffList(q), (r) =>
      BoardPublicationView.from(r),
    );
  }
}
