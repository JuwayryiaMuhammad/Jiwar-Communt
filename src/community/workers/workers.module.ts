import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { HouseholdsModule } from '../households/households.module';
import { WorkersAuthority } from './workers-authority';
import { WorkersService } from './workers.service';

/** Domestic workers (ADR 0017). No controllers yet: endpoints come with the design. */
@Module({
  imports: [AuthModule, HouseholdsModule],
  providers: [WorkersAuthority, WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}
