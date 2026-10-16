import { Module } from '@nestjs/common';
import { CommunityGovernancePortModule } from '../community';
import { GovernanceAccess } from './access';
import { GovernanceBoardController } from './board/board.controller';
import { BoardSeat } from './board/board-seat';
import { BoardService } from './board/board.service';
import { StaffBoardController } from './board/staff-board.controller';
import { GovernanceNotices } from './governance-notices';

/**
 * Governance (ADR 0051): the owners' board, its polls and elections. Reads
 * community through its index; nothing imports it.
 */
@Module({
  imports: [CommunityGovernancePortModule],
  controllers: [GovernanceBoardController, StaffBoardController],
  providers: [GovernanceAccess, GovernanceNotices, BoardSeat, BoardService],
})
export class GovernanceModule {}
