import { ResidentAppealItems } from './appeals/resident-appeal-items';
import { Module } from '@nestjs/common';
import { CommunityGovernancePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import { EngagementModule } from '../engagement';
import { GovernanceAccess } from './access';
import {
  BoardAppealsBoardController,
  BoardAppealsController,
  StaffBoardAppealsController,
} from './appeals/appeals.controller';
import { BoardAppealsService } from './appeals/appeals.service';
import {
  BoardApprovalsController,
  StaffApprovalsController,
} from './approvals/approvals.controller';
import { ApprovalsService } from './approvals/approvals.service';
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
import { BoardOverviewController } from './overview/overview.controller';
import { BoardOverviewService } from './overview/overview.service';
import { MatterSweeps } from './motions/matter-sweeps';
import { BoardMotionsController } from './motions/motions.controller';
import { MotionsService } from './motions/motions.service';
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
import { GovernanceProvisioning } from './provisioning';
import { GovernanceSettingsController } from './settings/governance-settings.controller';
import { GovernanceSettingsService } from './settings/governance-settings.service';

/**
 * Governance (ADR 0051, 0055): the owners' board, its polls and elections,
 * its decisions and minutes, and what the board decides by motions:
 * approval requests and appeals to the board. Reads community through its index, and engagement for
 * the board's notices; nothing imports it. What a decision does in another
 * domain is that domain's, registered with core's BoardMatters.
 */
@Module({
  imports: [
    AccountsModule,
    CommunityGovernancePortModule,
    EngagementModule,
    FilesModule,
  ],
  controllers: [
    GovernanceBoardController,
    StaffBoardController,
    GovernancePollsController,
    StaffGovernancePollsController,
    GovernanceElectionsController,
    StaffGovernanceElectionsController,
    BoardPublicationsController,
    StaffBoardPublicationsController,
    StaffApprovalsController,
    BoardApprovalsController,
    BoardMotionsController,
    GovernanceSettingsController,
    BoardAppealsController,
    StaffBoardAppealsController,
    BoardAppealsBoardController,
    BoardOverviewController,
  ],
  providers: [
    ResidentAppealItems,
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
    GovernanceProvisioning,
    GovernanceSettingsService,
    MotionsService,
    ApprovalsService,
    BoardAppealsService,
    BoardOverviewService,
    MatterSweeps,
  ],
})
export class GovernanceModule {}
