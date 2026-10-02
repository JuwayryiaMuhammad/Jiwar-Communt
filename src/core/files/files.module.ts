import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { ObjectStorage } from './object-storage';

/** Files in the private bucket (ADR 0029). Features use FilesService. */
@Module({
  imports: [AccountsModule],
  controllers: [FilesController],
  providers: [ObjectStorage, FilesService],
  exports: [FilesService],
})
export class FilesModule {}
