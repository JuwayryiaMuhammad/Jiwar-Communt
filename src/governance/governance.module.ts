import { Module } from '@nestjs/common';
import { CommunityGovernancePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { EngagementModule } from '../engagement';
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
import { CertificationService } from './elections/certification.service';
import { GovernanceElectionsService } from './elections/elections.service';
import { GovernanceNotices } from './governance-notices';
import { GovernanceExportSections } from './privacy/governance-export-sections';
import { GovernanceLifecycle } from './privacy/governance-lifecycle';
import {
  BoardPublicationsController,
  StaffBoardPublicationsController,
} from './publications/publications.controller';
import { BoardPublicationsService } from './publications/publications.service';
import {
  GovernancePollsController,
  StaffGovernancePollsController,
} from './polls/polls.controller';
import { GovernancePollsService } from './polls/polls.service';

/**
 * Governance (ADR 0051): the owners' board, its polls and elections, its
 * decisions and minutes. Reads community through its index, and engagement
 * for the board's notices; nothing imports it.
 */
@Module({
  imports: [AccountsModule, CommunityGovernancePortModule, EngagementModule],
  controllers: [
    GovernanceBoardController,
    StaffBoardController,
    GovernancePollsController,
    StaffGovernancePollsController,
    GovernanceElectionsController,
    StaffGovernanceElectionsController,
    BoardPublicationsController,
    StaffBoardPublicationsController,
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
    CertificationService,
    BoardPublicationsService,
    GovernanceLifecycle,
    GovernanceExportSections,
  ],
})
export class GovernanceModule {}
