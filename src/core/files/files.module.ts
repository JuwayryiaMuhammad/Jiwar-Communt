import { Module } from '@nestjs/common';
import { FilesService } from './files.service';
import { ObjectStorage } from './object-storage';

/**
 * Uploads into private object storage (ADR 0029). A feature module imports
 * this and stores the file inside its own action; there is no controller.
 */
@Module({
  providers: [ObjectStorage, FilesService],
  exports: [FilesService],
})
export class FilesModule {}
