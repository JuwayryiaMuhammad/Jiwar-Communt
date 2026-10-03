import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AccountPhotoService } from './account-photo.service';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { MePhotoController } from './me-photo.controller';
import { ObjectStorageModule } from './object-storage.module';

/** Files in the private bucket (ADR 0029). Features use FilesService. */
@Module({
  imports: [AccountsModule, ObjectStorageModule],
  controllers: [FilesController, MePhotoController],
  providers: [FilesService, AccountPhotoService],
  exports: [FilesService],
})
export class FilesModule {}
