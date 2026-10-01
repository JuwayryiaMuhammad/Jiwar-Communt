import { Module } from '@nestjs/common';
import { CommunityGatePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { AuthModule } from '../core/auth/auth.module';
import { TenantSettingsModule } from '../core/tenant-settings/tenant-settings.module';
import { GatesController } from './gates/gates.controller';
import { GatesService } from './gates/gates.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { InstructionsService } from './visitors/instructions.service';
import { VisitorDataSweep } from './visitors/visitor-data.sweep';
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
    TenantSettingsModule,
    CommunityGatePortModule,
  ],
  controllers: [GatesController, ShiftsController, VisitorsController],
  providers: [
    GatesService,
    ShiftsService,
    VisitorPassesService,
    InstructionsService,
    VisitorDataSweep,
  ],
})
export class GateModule {}
