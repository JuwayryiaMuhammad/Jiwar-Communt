import { Module } from '@nestjs/common';
import { AttachedFileUrls } from './attached-file-urls';
import { ObjectStorage } from './object-storage';

/**
 * The store and presigned reads, with no dependency on accounts: both
 * FilesModule and AccountsModule use them (ADR 0031).
 */
@Module({
  providers: [ObjectStorage, AttachedFileUrls],
  exports: [ObjectStorage, AttachedFileUrls],
})
export class ObjectStorageModule {}
