import { WorkersController } from './workers.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { HouseholdsModule } from '../households/households.module';
import { NoticesModule } from '../notices/notices.module';
import { WorkersAuthority } from './workers-authority';
import { WorkersService } from './workers.service';

/** Domestic workers (ADR 0017, 0022). */
@Module({
  controllers: [WorkersController],
  imports: [AuthModule, HouseholdsModule, NoticesModule],
  providers: [WorkersAuthority, WorkersService],
  exports: [WorkersService, WorkersAuthority],
})
export class WorkersModule {}
