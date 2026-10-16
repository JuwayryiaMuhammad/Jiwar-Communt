import { Module } from '@nestjs/common';
import { CommunityGovernancePortModule } from '../community';
import { GovernanceAccess } from './access';
import { GovernanceBoardController } from './board/board.controller';
import { BoardSeat } from './board/board-seat';
import { BoardService } from './board/board.service';
import { StaffBoardController } from './board/staff-board.controller';
import { ContestSweeps } from './contests/contest-sweeps';
import { Contests } from './contests/contests.service';
import {
  GovernanceElectionsController,
  StaffGovernanceElectionsController,
} from './elections/elections.controller';
import { GovernanceElectionsService } from './elections/elections.service';
import { GovernanceNotices } from './governance-notices';
import {
  GovernancePollsController,
  StaffGovernancePollsController,
} from './polls/polls.controller';
import { GovernancePollsService } from './polls/polls.service';

/**
 * Governance (ADR 0051): the owners' board, its polls and elections. Reads
 * community through its index; nothing imports it.
 */
@Module({
  imports: [CommunityGovernancePortModule],
  controllers: [
    GovernanceBoardController,
    StaffBoardController,
    GovernancePollsController,
    StaffGovernancePollsController,
    GovernanceElectionsController,
    StaffGovernanceElectionsController,
  ],
  providers: [
    GovernanceAccess,
    GovernanceNotices,
    BoardSeat,
    BoardService,
    Contests,
    ContestSweeps,
    GovernancePollsService,
    GovernanceElectionsService,
  ],
})
export class GovernanceModule {}
