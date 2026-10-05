import { Module } from '@nestjs/common';
import { CommunityGatePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import { AuthModule } from '../core/auth/auth.module';
import { TenantSettingsModule } from '../core/tenant-settings/tenant-settings.module';
import { ApprovalsService } from './approvals/approvals.service';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import {
  GuardApprovalsController,
  HostApprovalsController,
} from './approvals/approvals.controller';
import { EntriesController } from './entries/entries.controller';
import { EntryCredentialsController } from './entry/entry-credentials.controller';
import { EntryCredentialsService } from './entry/entry-credentials.service';
import { EntrySecrets } from './entry/entry-secrets';
import { ResidentVerifier } from './entry/resident-verifier';
import { EntriesService } from './entries/entries.service';
import { GateSubjects } from './entries/subjects';
import { VerifyService } from './entries/verify.service';
import { GatesController } from './gates/gates.controller';
import { GatesService } from './gates/gates.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { GateParcelsController } from './parcels/gate-parcels.controller';
import { ResidentParcelsController } from './parcels/resident-parcels.controller';
import { ResidentParcels } from './parcels/resident-parcels.service';
import { ParcelHandover } from './parcels/parcel-handover.service';
import { ParcelCore } from './parcels/parcel-core';
import { ParcelsService } from './parcels/parcels.service';
import { ParcelTokens } from './parcels/parcel-tokens';
import { ParcelProvisioning } from './parcels/parcel-provisioning';
import { InstructionsService } from './visitors/instructions.service';
import { VisitorDataSweep } from './visitors/visitor-data.sweep';
import { VisitorPageController } from './visitors/visitor-page.controller';
import { VisitorPageService } from './visitors/visitor-page.service';
import { VisitorPassesService } from './visitors/visitor-passes.service';
import { VisitorsController } from './visitors/visitors.controller';

/**
 * The gate domain (ADR 0028). It imports core freely and the community
 * domain only through src/community/index.ts (ADR 0015).
 */
@Module({
  imports: [
    AccountsModule,
    AuthModule,
    FilesModule,
    TenantSettingsModule,
    CommunityGatePortModule,
  ],
  controllers: [
    GatesController,
    ShiftsController,
    VisitorsController,
    VisitorPageController,
    EntriesController,
    GuardApprovalsController,
    HostApprovalsController,
    AttendanceController,
    EntryCredentialsController,
    GateParcelsController,
    ResidentParcelsController,
  ],
  providers: [
    GatesService,
    ShiftsService,
    VisitorPassesService,
    VisitorPageService,
    InstructionsService,
    VisitorDataSweep,
    GateSubjects,
    EntriesService,
    VerifyService,
    ApprovalsService,
    AttendanceService,
    EntrySecrets,
    EntryCredentialsService,
    ResidentVerifier,
    ParcelProvisioning,
    ParcelTokens,
    ParcelCore,
    ParcelsService,
    ResidentParcels,
    ParcelHandover,
  ],
})
export class GateModule {}
