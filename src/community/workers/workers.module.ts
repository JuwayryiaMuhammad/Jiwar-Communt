import { WorkersController } from './workers.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { FilesModule } from '../../core/files/files.module';
import { HouseholdsModule } from '../households/households.module';
import { NoticesModule } from '../notices/notices.module';
import { WorkerPhotoRetention } from './photo-retention';
import { WorkersAuthority } from './workers-authority';
import { WorkersService } from './workers.service';

/** Domestic workers (ADR 0017, 0022). */
@Module({
  controllers: [WorkersController],
  imports: [AuthModule, FilesModule, HouseholdsModule, NoticesModule],
  providers: [WorkersAuthority, WorkersService, WorkerPhotoRetention],
  exports: [WorkersService, WorkersAuthority],
})
export class WorkersModule {}
