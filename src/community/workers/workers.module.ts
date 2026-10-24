import { WorkersController } from './workers.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { FilesModule } from '../../core/files/files.module';
import { HouseholdsModule } from '../households/households.module';
import { NoticesModule } from '../notices/notices.module';
import { EngagementTokens } from './engagement-tokens';
import { WorkerPhotoRetention } from './photo-retention';
import { WorkerDecisionAppeals } from './worker-decision-appeals';
import { WorkerWagesService } from './worker-wages.service';
import { WorkersAuthority } from './workers-authority';
import { WorkersService } from './workers.service';

/** Domestic workers (ADR 0017, 0022). */
@Module({
  controllers: [WorkersController],
  imports: [AuthModule, FilesModule, HouseholdsModule, NoticesModule],
  providers: [
    WorkersAuthority,
    WorkersService,
    EngagementTokens,
    WorkerWagesService,
    WorkerPhotoRetention,
    WorkerDecisionAppeals,
  ],
  exports: [WorkersService, WorkersAuthority, EngagementTokens],
})
export class WorkersModule {}
