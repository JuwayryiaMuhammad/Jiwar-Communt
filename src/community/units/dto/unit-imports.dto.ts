import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { UNIT_IMPORT_KINDS, type UnitImportKind } from '../unit-import-rules';

export class CheckUnitImportDto {
  @ApiProperty({
    enum: UNIT_IMPORT_KINDS,
    description:
      '`units`: code, and building, floor, unit_type, area_sqm (up to 2000 rows). `residents`: full_name, phone, email, id_document_type, id_document_number, unit, occupancy_type, and nationality, birth_date, resides, preferred_locale (up to 300 rows).',
  })
  @IsIn(UNIT_IMPORT_KINDS, withParams({ allowed: [...UNIT_IMPORT_KINDS] }))
  kind: UnitImportKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'One of the caller’s finalized `data_import` files: UTF-8 CSV with a header row.',
  })
  @IsUUID()
  fileId: string;
}
