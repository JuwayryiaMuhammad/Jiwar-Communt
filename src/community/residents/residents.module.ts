import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { HouseholdsModule } from '../households/households.module';
import { ResidentsService } from './residents.service';

/** No controllers yet: endpoints come with the design (Phase 1a). */
@Module({
  imports: [AccountsModule, HouseholdsModule],
  providers: [ResidentsService],
  exports: [ResidentsService],
})
export class ResidentsModule {}
