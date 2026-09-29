import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { ResidentsService } from './residents.service';

/** No controllers yet: endpoints come with the design (Phase 1a). */
@Module({
  imports: [AccountsModule],
  providers: [ResidentsService],
  exports: [ResidentsService],
})
export class ResidentsModule {}
