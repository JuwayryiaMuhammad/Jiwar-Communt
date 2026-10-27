import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CheckAssetImportDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'One of the caller’s finalized `data_import` files: UTF-8 CSV, a header row (code, type, name_ar, name_en, and unit, area or parent, …).',
  })
  @IsUUID()
  fileId: string;
}
