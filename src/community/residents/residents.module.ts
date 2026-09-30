import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { HouseholdsModule } from '../households/households.module';
import { NoticesModule } from '../notices/notices.module';
import { WorkersModule } from '../workers/workers.module';
import { ErasureHooks } from './erasure-hooks';
import { FreezeHooks } from './freeze-hooks';
import { RegistrationService } from './registration.service';
import { AuthModule } from '../../core/auth/auth.module';
import { ResidentsService } from './residents.service';

/** No controllers yet: endpoints come with the design (Phase 1a). */
@Module({
  imports: [
    AccountsModule,
    AuthModule,
    HouseholdsModule,
    NoticesModule,
    WorkersModule,
  ],
  providers: [ResidentsService, FreezeHooks, ErasureHooks, RegistrationService],
  exports: [ResidentsService, RegistrationService],
})
export class ResidentsModule {}
