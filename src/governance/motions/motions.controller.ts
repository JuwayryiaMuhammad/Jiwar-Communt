import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BoardVoteDto } from './dto/motions.dto';
import { MotionsService } from './motions.service';
import { BoardMotionView } from './views/motions.views';

/** Voting on the board's motions (ADR 0055): a sitting member. */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/motions')
export class BoardMotionsController {
  constructor(private readonly motions: MotionsService) {}

  @Post(':id/votes')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Vote on a motion',
    description:
      'For or against, once (BOARD_ALREADY_VOTED). The vote that decides it closes it: a carried motion decides its matter at once.',
  })
  @ApiCreatedResponse({ type: BoardMotionView })
  async vote(
    @Param('id', parseId()) id: string,
    @Body() dto: BoardVoteDto,
  ): Promise<BoardMotionView> {
    return BoardMotionView.from(await this.motions.vote(id, dto.choice));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Close a motion',
    description:
      'When its count is decided, or past the matter’s deadline as the votes stand with a quorum (BOARD_VOTE_NOT_DUE, BOARD_QUORUM_NOT_MET).',
  })
  @ApiOkResponse({ type: BoardMotionView })
  async close(@Param('id', parseId()) id: string): Promise<BoardMotionView> {
    return BoardMotionView.from(await this.motions.close(id));
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Withdraw a motion',
    description: 'Its proposer, while open (BOARD_MOTION_NOT_YOURS).',
  })
  @ApiOkResponse({ type: BoardMotionView })
  async withdraw(@Param('id', parseId()) id: string): Promise<BoardMotionView> {
    return BoardMotionView.from(await this.motions.withdraw(id));
  }
}
