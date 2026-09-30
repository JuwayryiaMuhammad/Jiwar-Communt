import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { HouseholdsModule } from '../households/households.module';
import { NoticesModule } from '../notices/notices.module';
import { WorkersModule } from '../workers/workers.module';
import { ErasureHooks } from './erasure-hooks';
import { FreezeHooks } from './freeze-hooks';
import { CapabilitiesModule } from '../capabilities/capabilities.module';
import { MeUnitsController } from './me-units.controller';
import { OccupanciesController } from './occupancies.controller';
import { UnitActionsController } from './unit-actions.controller';
import { RegistrationPublicController } from './registration-public.controller';
import { RegistrationService } from './registration.service';
import { AuthModule } from '../../core/auth/auth.module';
import { ResidentsService } from './residents.service';

/** Residents, occupancies, unit states and self-registration (API v0). */
@Module({
  controllers: [
    RegistrationPublicController,
    MeUnitsController,
    UnitActionsController,
    OccupanciesController,
  ],
  imports: [
    AccountsModule,
    AuthModule,
    CapabilitiesModule,
    HouseholdsModule,
    NoticesModule,
    WorkersModule,
  ],
  providers: [ResidentsService, FreezeHooks, ErasureHooks, RegistrationService],
  exports: [ResidentsService, RegistrationService],
})
export class ResidentsModule {}
