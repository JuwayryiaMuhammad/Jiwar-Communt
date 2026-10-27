import { ApiProperty } from '@nestjs/swagger';
import type { AssetImport } from '@prisma/client';
import type { ImportProblem } from '../asset-import-rules';

class AssetImportProblemView {
  @ApiProperty({
    type: Number,
    description: 'The sheet’s line; the header is 1.',
  })
  line: number;
  @ApiProperty({ type: String, description: 'The column.' })
  field: string;
  @ApiProperty({ type: String, description: 'A field error code.' })
  code: string;
}

/** An asset sheet (ADR 0064): what was found, and what was applied. */
export class AssetImportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ['valid', 'invalid', 'applied'] })
  status: 'valid' | 'invalid' | 'applied';
  @ApiProperty({ type: Number })
  rowCount: number;
  @ApiProperty({ type: Number })
  errorCount: number;
  @ApiProperty({
    type: [AssetImportProblemView],
    description: 'The first 100 problems, in sheet order. Never a cell’s text.',
  })
  errors: AssetImportProblemView[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Assets created, once applied.',
  })
  appliedCount: number | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appliedAt: Date | null;

  static from(i: AssetImport): AssetImportView {
    return {
      id: i.id,
      status: i.status as AssetImportView['status'],
      rowCount: i.rowCount,
      errorCount: i.errorCount,
      errors: i.errors as unknown as ImportProblem[],
      appliedCount: i.appliedCount,
      createdAt: i.createdAt,
      appliedAt: i.appliedAt,
    };
  }
}
