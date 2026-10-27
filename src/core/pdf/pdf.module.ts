import { Global, Module } from '@nestjs/common';
import { PdfRenderer } from './pdf-renderer';

/** Server-side PDFs (ADR 0062). Global: any domain that issues a document draws it here. */
@Global()
@Module({ providers: [PdfRenderer], exports: [PdfRenderer] })
export class PdfModule {}
