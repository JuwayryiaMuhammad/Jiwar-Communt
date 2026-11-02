import { Global, Module } from '@nestjs/common';
import { VendorDirectory } from './vendor-directory';

/** The compound's vendors for a spend (ADR 0077): maintenance registers the resolver. */
@Global()
@Module({ providers: [VendorDirectory], exports: [VendorDirectory] })
export class VendorDirectoryModule {}
