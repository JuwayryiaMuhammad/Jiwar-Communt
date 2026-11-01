import { ApiProperty } from '@nestjs/swagger';
import type { UnitImport } from '@prisma/client';
import type { ImportProblem, UnitImportKind } from '../unit-import-rules';

class UnitImportProblemView {
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

/** A sheet of units or residents (ADR 0072): what was found, and what was applied. */
export class UnitImportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ['units', 'residents'] })
  kind: UnitImportKind;
  @ApiProperty({ enum: ['valid', 'invalid', 'applied', 'expired'] })
  status: 'valid' | 'invalid' | 'applied' | 'expired';
  @ApiProperty({ type: Number })
  rowCount: number;
  @ApiProperty({ type: Number })
  errorCount: number;
  @ApiProperty({
    type: [UnitImportProblemView],
    description: 'The first 100 problems, in sheet order. Never a cell’s text.',
  })
  errors: UnitImportProblemView[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Units or residents created, once applied.',
  })
  appliedCount: number | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appliedAt: Date | null;

  static from(i: UnitImport): UnitImportView {
    return {
      id: i.id,
      kind: i.kind as UnitImportKind,
      status: i.status as UnitImportView['status'],
      rowCount: i.rowCount,
      errorCount: i.errorCount,
      errors: i.errors as unknown as ImportProblem[],
      appliedCount: i.appliedCount,
      createdAt: i.createdAt,
      appliedAt: i.appliedAt,
    };
  }
}
